// 云函数：csvImport —— 服务端解析 CSV 并批量导入账单
// 解决问题：前端无法可靠解码 GBK 编码的 CSV，导致分类/事项乱码
// Node.js TextDecoder 原生支持 GBK/GB18030，在此完成全部解析+导入
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
async function getCurrentPair(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣再导入' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: buildPairKey(memberIds) };
}

// 分类定义（key → 中文名）
const CATEGORIES = {
  food: '餐饮', transport: '交通', shopping: '购物',
  fun: '娱乐', house: '居住', medical: '医疗',
  gift: '人情', other: '其他',
  salary: '工资', sidejob: '兼职',
  redpacket: '红包', invest: '理财'
};

// 分类别名表（中文/英文 → key），用于模糊匹配
const CAT_ALIASES = {
  // 餐饮
  '餐饮': 'food', 'food': 'food', '吃饭': 'food', '餐费': 'food', '伙食': 'food',
  '早餐': 'food', '午餐': 'food', '晚餐': 'food', '宵夜': 'food', '外卖': 'food',
  '饭店': 'food', '零食': 'food', '饮料': 'food', '咖啡': 'food', '奶茶': 'food',
  // 交通
  '交通': 'transport', 'transport': 'transport', '打车': 'transport', '地铁': 'transport',
  '公交': 'transport', '出行': 'transport', '油费': 'transport', '加油': 'transport',
  '停车': 'transport', '高铁': 'transport', '火车': 'transport', '飞机': 'transport',
  '滴滴': 'transport', '出租车': 'transport', '车费': 'transport', '机票': 'transport',
  // 购物
  '购物': 'shopping', 'shopping': 'shopping', '超市': 'shopping', '淘宝': 'shopping',
  '京东': 'shopping', '网购': 'shopping', '日用': 'shopping', '百货': 'shopping',
  '服饰': 'shopping', '衣服': 'shopping', '鞋帽': 'shopping', '数码': 'shopping',
  // 娱乐
  '娱乐': 'fun', 'fun': 'fun', '电影': 'fun', '游戏': 'fun', '旅游': 'fun',
  '话费': 'fun', '充值': 'fun', 'KTV': 'fun', '唱歌': 'fun', '休闲': 'fun',
  '视频': 'fun', '会员': 'fun',
  // 居住
  '居住': 'house', 'house': 'house', '房租': 'house', '水电': 'house',
  '物业': 'house', '煤气': 'house', '燃气': 'house', '电费': 'house', '水费': 'house',
  '宽带': 'house', '网费': 'house',
  // 医疗
  '医疗': 'medical', 'medical': 'medical', '看病': 'medical', '药费': 'medical',
  '医院': 'medical', '买药': 'medical', '门诊': 'medical', '体检': 'medical',
  // 人情
  '人情': 'gift', 'gift': 'gift', '礼物': 'gift', '送礼': 'gift',
  '份子钱': 'gift', '请客': 'gift', '聚餐': 'gift',
  // 工资
  '工资': 'salary', 'salary': 'salary', '薪水': 'salary', '发薪': 'salary',
  // 兼职
  '兼职': 'sidejob', 'sidejob': 'sidejob', '外快': 'sidejob', '副业': 'sidejob',
  // 红包
  '红包': 'redpacket', 'redpacket': 'redpacket', '压岁钱': 'redpacket',
  // 理财
  '理财': 'invest', 'invest': 'invest', '基金': 'invest', '股票': 'invest',
  '利息': 'invest', '收益': 'invest',
  // 其他
  '其他': 'other', 'other': 'other', '杂项': 'other', '杂费': 'other'
};

/**
 * 模糊匹配分类：精确 → 包含 → 被包含 → 默认 other
 */
function matchCategory(rawCat) {
  if (!rawCat) return 'other';
  const trimmed = String(rawCat).trim();
  if (!trimmed) return 'other';

  // 1. 精确匹配（含大小写不敏感）
  if (CAT_ALIASES[trimmed]) return CAT_ALIASES[trimmed];
  const lower = trimmed.toLowerCase();
  if (CAT_ALIASES[lower]) return CAT_ALIASES[lower];

  // 2. 包含匹配：输入包含某个已知别名（如「餐饮费」包含「餐饮」）
  //    按别名长度降序排列，优先匹配更具体的
  const sortedAliases = Object.keys(CAT_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) {
    if (trimmed.includes(alias)) return CAT_ALIASES[alias];
  }

  // 3. 被包含匹配：已知别名包含输入（如输入「餐」匹配「餐饮」）
  //    仅当输入长度 >= 2 时启用，避免过短匹配
  if (trimmed.length >= 2) {
    for (const alias of sortedAliases) {
      if (alias.includes(trimmed) && alias.length <= trimmed.length + 3) {
        return CAT_ALIASES[alias];
      }
    }
  }

  return 'other';
}

/**
 * 解析 CSV 单行（支持双引号包裹和转义）
 */
function parseCSVLine(line, sep) {
  const separator = sep || ',';
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === separator && !inQuotes) {
      result.push(current); current = '';
    } else current += ch;
  }
  result.push(current);
  return result;
}

/** 自动检测 CSV 分隔符 */
function detectDelimiter(headerLine) {
  if (headerLine.indexOf('\t') >= 0) return '\t';
  if (headerLine.indexOf(';') >= 0 && headerLine.indexOf(',') < 0) return ';';
  return ',';
}

/** 清洗 CSV 单元格值 */
function cleanCSVValue(s) {
  return String(s || '')
    .replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '')
    .trim();
}

/** 清洗乱码字符 */
function sanitize(str) {
  if (!str) return '';
  return String(str)
    .replace(/\uFFFD/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/^\?+$/, '')
    .trim();
}

/** 日期标准化：支持 2026/08/01、2026.08.01、2026-8-1 等 */
function normalizeDate(s) {
  s = s.trim().replace(/[\/\.]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return s;
  return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
}

/**
 * Base64 → Buffer → 检测编码 → 解码为字符串
 * Node.js TextDecoder 原生支持 UTF-8 / GBK / GB18030
 */
function decodeFileContent(base64) {
  const buf = Buffer.from(base64, 'base64');

  // 1. 检查 UTF-8 BOM (EF BB BF)
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    console.log('[csvImport] 检测到 UTF-8 BOM');
    return buf.slice(3).toString('utf8');
  }

  // 2. 检查 UTF-16 LE BOM (FF FE)
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    console.log('[csvImport] 检测到 UTF-16 LE BOM');
    try {
      return new TextDecoder('utf-16le').decode(buf);
    } catch (e) {
      console.warn('[csvImport] UTF-16LE 解码失败');
    }
  }

  // 3. 验证是否为合法 UTF-8
  let isValidUTF8 = true;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b <= 0x7F) continue;
    let need = 0;
    if ((b & 0xE0) === 0xC0) need = 1;
    else if ((b & 0xF0) === 0xE0) need = 2;
    else if ((b & 0xF8) === 0xF0) need = 3;
    else { isValidUTF8 = false; break; }
    for (let j = 1; j <= need; j++) {
      if (i + j >= buf.length || (buf[i + j] & 0xC0) !== 0x80) {
        isValidUTF8 = false; break;
      }
    }
    if (!isValidUTF8) break;
    i += need;
  }

  if (isValidUTF8) {
    console.log('[csvImport] 合法 UTF-8，直接解码');
    return buf.toString('utf8');
  }

  // 4. 非 UTF-8 → 尝试 GB18030（兼容 GBK 的超集，覆盖更广）
  console.log('[csvImport] 非 UTF-8，尝试 GB18030 解码');
  try {
    const content = new TextDecoder('gb18030').decode(buf);
    console.log('[csvImport] GB18030 解码成功');
    return content;
  } catch (e) {
    console.warn('[csvImport] GB18030 不支持，尝试 GBK:', e.message);
  }

  // 5. 尝试 GBK
  try {
    const content = new TextDecoder('gbk').decode(buf);
    console.log('[csvImport] GBK 解码成功');
    return content;
  } catch (e) {
    console.warn('[csvImport] GBK 不支持');
  }

  // 6. 兜底：latin1（不会产生乱码替换字符，但中文不可读）
  console.warn('[csvImport] 所有编码解码失败，使用 latin1 兜底');
  return buf.toString('latin1');
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { fileBase64 } = event;

  if (!fileBase64) {
    return { success: false, msg: '没有文件内容' };
  }

  // 限制文件大小（Base64 约 1.5MB = 原始约 1.1MB）
  if (fileBase64.length > 1500000) {
    return { success: false, msg: '文件过大，请精简到 500 条以内' };
  }

  try {
    // ========== 1. 解码文件内容 ==========
    let content = decodeFileContent(fileBase64);
    content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = content.split('\n').filter(function (l) { return l.trim(); });

    if (lines.length < 2) {
      return { success: false, msg: 'CSV 文件为空或只有表头，无数据行' };
    }

    // ========== 2. 解析表头 ==========
    const headerLine = lines[0];
    const sep = detectDelimiter(headerLine);
    console.log('[csvImport] 分隔符:', sep === '\t' ? 'TAB' : sep);
    const headerCols = parseCSVLine(headerLine, sep).map(cleanCSVValue);

    const colIndex = {};
    headerCols.forEach(function (h, idx) {
      if (/日期|date|时间/i.test(h)) colIndex.date = idx;
      else if (/类型|type/i.test(h)) colIndex.type = idx;
      else if (/分类|category/i.test(h)) colIndex.category = idx;
      else if (/金额|amount/i.test(h)) colIndex.amount = idx;
      else if (/事项|matter|用途|摘要/i.test(h)) colIndex.matter = idx;
      else if (/备注|note|说明|memo/i.test(h)) colIndex.note = idx;
    });

    let isStandard = colIndex.date !== undefined &&
      colIndex.type !== undefined &&
      colIndex.category !== undefined;

    // 表头识别成功但金额列未找到 → 从数据行自动检测
    if (isStandard && colIndex.amount === undefined && lines.length > 1) {
      var sampleRows = lines.slice(1, Math.min(6, lines.length))
        .map(function (l) { return parseCSVLine(l, sep).map(cleanCSVValue); });
      for (var c = 0; c < (sampleRows[0] || []).length; c++) {
        if (c === colIndex.date || c === colIndex.type || c === colIndex.category) continue;
        var numCount = sampleRows.filter(function (row) {
          var v = parseFloat(row[c]);
          return !isNaN(v) && v > 0;
        }).length;
        if (numCount >= Math.ceil(sampleRows.length / 2)) {
          colIndex.amount = c;
          console.log('[csvImport] 金额列自动检测: 索引', c);
          break;
        }
      }
    }

    console.log('[csvImport] 表头解析:', JSON.stringify({
      headerCols: headerCols, colIndex: colIndex, isStandard: isStandard
    }));

    // ========== 3. 数据驱动列检测（表头识别失败时回退） ==========
    if (!isStandard && lines.length > 1) {
      console.log('[csvImport] 表头解析不完整，尝试数据驱动列检测');
      var sampleRows2 = lines.slice(1, Math.min(11, lines.length))
        .map(function (l) { return parseCSVLine(l, sep).map(cleanCSVValue); });
      var numCols = Math.max.apply(null, sampleRows2.map(function (r) { return r.length; }));

      // 检测分类列：哪一列的值最多匹配 CAT_ALIASES
      var catMatchScores = {};
      for (var c2 = 0; c2 < numCols; c2++) {
        var score = 0;
        sampleRows2.forEach(function (row) {
          var val = (row[c2] || '').trim();
          if (matchCategory(val) !== 'other') score++;
        });
        if (score > 0) catMatchScores[c2] = score;
      }
      var catColKeys = Object.keys(catMatchScores).sort(function (a, b) {
        return catMatchScores[b] - catMatchScores[a];
      });
      var catCol = catColKeys[0];
      if (catCol !== undefined && catMatchScores[catCol] >= 2) {
        var cc = parseInt(catCol);
        colIndex.category = cc;
        // 分类列之前可能是日期、类型
        if (cc >= 2) { colIndex.date = 0; colIndex.type = 1; }
        // 分类列之后第一个数字列 → 金额
        for (var c3 = cc + 1; c3 < numCols; c3++) {
          var hasNum = sampleRows2.some(function (row) {
            var v = parseFloat(row[c3]);
            return !isNaN(v) && v > 0;
          });
          if (hasNum && colIndex.amount === undefined) { colIndex.amount = c3; break; }
        }
        // 金额列之后 → 事项、备注
        if (colIndex.amount !== undefined) {
          var remaining = [];
          for (var c4 = colIndex.amount + 1; c4 < numCols; c4++) {
            if (c4 !== cc) remaining.push(c4);
          }
          if (remaining.length >= 1) colIndex.matter = remaining[0];
          if (remaining.length >= 2) colIndex.note = remaining[1];
        }
        isStandard = true;
        console.log('[csvImport] 数据驱动检测结果:', JSON.stringify(colIndex));
      }
    }

    // ========== 4. 解析数据行 ==========
    var bills = [];
    var skipped = 0;
    var errors = [];

    for (var i = 1; i < lines.length; i++) {
      var cols = parseCSVLine(lines[i], sep).map(cleanCSVValue);
      if (cols.length < 4) { skipped++; continue; }

      var billDate, typeRaw, category, amount, matter = '', note = '';

      if (isStandard) {
        billDate = (cols[colIndex.date] || '').trim();
        typeRaw = (cols[colIndex.type] || '').trim();
        category = (cols[colIndex.category] || '').trim();
        amount = parseFloat(String(cols[colIndex.amount] || '').replace(/,/g, '').trim());
        matter = colIndex.matter !== undefined ? (cols[colIndex.matter] || '').trim() : '';
        note = colIndex.note !== undefined ? (cols[colIndex.note] || '').trim() : '';
      } else {
        // 兼容旧格式（无表头或表头不匹配）
        billDate = cols[0].trim();
        typeRaw = cols[1].trim();
        var second = parseFloat(String(cols[2] || '').replace(/,/g, '').trim());
        if (!isNaN(second) && second > 0) {
          // 格式 A：日期,类型,金额,分类,备注
          amount = second;
          category = (cols[3] || '').trim();
          matter = (cols[4] || '').trim();
        } else {
          // 格式 B：日期,类型,分类,金额,备注
          category = cols[2].trim();
          amount = parseFloat(String(cols[3] || '').replace(/,/g, '').trim());
          matter = (cols[4] || '').trim();
        }
      }

      // 清洗金额（去千分位逗号）
      billDate = normalizeDate(billDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || isNaN(amount) || amount <= 0) {
        skipped++;
        if (errors.length < 5) {
          errors.push('第' + (i + 1) + '行: 日期或金额无效');
        }
        continue;
      }

      var isIncome = typeRaw.indexOf('收入') >= 0 || typeRaw.toLowerCase() === 'income';
      var catKey = matchCategory(category);
      var cleanMatter = sanitize(matter).slice(0, 30);
      var cleanNote = sanitize(note).slice(0, 50);

      // 调试：前3条解析结果
      if (bills.length < 3) {
        console.log('[csvImport] 第' + (i + 1) + '行解析:', JSON.stringify({
          billDate: billDate, typeRaw: typeRaw, category: category,
          catKey: catKey, amount: amount, matter: cleanMatter, note: cleanNote
        }));
      }

      bills.push({
        type: isIncome ? 'income' : 'expense',
        category: catKey,
        amount: Math.round(Math.abs(amount) * 100) / 100,
        matter: cleanMatter,
        note: cleanNote,
        billDate: billDate
      });
    }

    if (bills.length === 0) {
      return {
        success: false,
        msg: '未解析到有效账单，请确认 CSV 格式（参考模板）',
        skipped: skipped,
        errors: errors,
        debug: { headerCols: headerCols, colIndex: colIndex, isStandard: isStandard }
      };
    }

    // ========== 5. 获取用户信息 ==========
    var pair = await getCurrentPair(OPENID);
    if (pair.error) return pair.error;
    var me = pair.me;

    // ========== 6. 批量写入数据库 ==========
    var billsCol = db.collection('bills');
    var successCount = 0;
    var failCount = 0;

    for (var j = 0; j < bills.length; j++) {
      var b = bills[j];
      try {
        await billsCol.add({
          data: {
            openid: OPENID,
            creatorId: me._id,
            creatorName: me.nickName || '伴侣',
            partnerId: pair.partner._id,
            pairKey: pair.pairKey,
            memberIds: pair.memberIds,
            type: b.type,
            category: b.category,
            categoryName: CATEGORIES[b.category] || '其他',
            amount: b.amount,
            matter: b.matter,
            note: b.note,
            billDate: b.billDate,
            createdAt: db.serverDate()
          }
        });
        successCount++;
      } catch (err) {
        console.error('[csvImport] 写入失败:', err);
        failCount++;
      }
    }

    console.log('[csvImport] 导入完成: 成功' + successCount + ' 失败' + failCount +
      ' 跳过' + skipped + ' 总计' + bills.length);

    return {
      success: true,
      count: successCount,
      fail: failCount,
      skipped: skipped,
      parsed: bills.length,
      errors: errors,
      debug: {
        headerCols: headerCols,
        colIndex: colIndex,
        isStandard: isStandard,
        sampleBills: bills.slice(0, 3)
      }
    };
  } catch (err) {
    console.error('[csvImport] 失败', err);
    return { success: false, msg: '导入失败: ' + (err.message || String(err)) };
  }
};
