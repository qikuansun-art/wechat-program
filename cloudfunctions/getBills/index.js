const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const MAX_PAGE_SIZE = 50;
const CATEGORY_KEYS = new Set(['food', 'transport', 'shopping', 'fun', 'house', 'medical', 'gift', 'other', 'salary', 'sidejob', 'redpacket', 'invest']);

function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function monthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  return { start: `${yearMonth}-01`, end: month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01` };
}
function sanitize(value) {
  return value ? String(value).replace(/\uFFFD/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/^\?+$/, '').trim() : '';
}
async function getBoundUsers(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || me.partnerId !== partner._id || partner.partnerId !== me._id) {
    return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  }
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: memberIds.join('|') };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const yearMonth = String(event.yearMonth || '');
  if (!validMonth(yearMonth)) return { success: false, code: 'INVALID_MONTH', msg: '月份参数错误' };
  const page = Math.max(0, parseInt(event.page, 10) || 0);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(event.pageSize, 10) || MAX_PAGE_SIZE));
  const type = event.type === undefined || event.type === '' ? 'all' : String(event.type);
  const person = event.person === undefined || event.person === '' ? 'all' : String(event.person);
  const category = event.category === undefined ? '' : String(event.category);
  if (!['all', 'expense', 'income'].includes(type)) return { success: false, code: 'INVALID_TYPE', msg: '收支类型不合法' };
  if (!['all', 'mine', 'partner'].includes(person)) return { success: false, code: 'INVALID_PERSON', msg: '人员筛选不合法' };
  if (category && !CATEGORY_KEYS.has(category)) return { success: false, code: 'INVALID_CATEGORY', msg: '账单分类不合法' };
  try {
    const auth = await getBoundUsers(OPENID);
    if (auth.error) return auth.error;
    const range = monthRange(yearMonth);
    const where = { pairKey: auth.pairKey, billDate: _.gte(range.start).and(_.lt(range.end)) };
    if (person === 'mine') where.creatorId = auth.me._id;
    if (person === 'partner') where.creatorId = auth.partner._id;
    if (type !== 'all') where.type = type;
    if (category) where.category = category;
    const res = await db.collection('bills').where(where)
      .orderBy('billDate', 'desc').orderBy('createdAt', 'desc').orderBy('_id', 'desc')
      .skip(page * pageSize).limit(pageSize + 1).get();
    const hasMore = res.data.length > pageSize;
    const list = res.data.slice(0, pageSize).map((item) => ({
      id: item._id, type: item.type, category: item.category, categoryName: item.categoryName,
      amount: item.amount, matter: sanitize(item.matter), note: sanitize(item.note), billDate: item.billDate,
      creatorName: item.creatorName, creatorId: item.creatorId, mine: item.creatorId === auth.me._id, createdAt: item.createdAt
    }));
    return { success: true, list, page, pageSize, hasMore };
  } catch (err) {
    console.error('[getBills] 失败', err);
    return { success: false, code: 'QUERY_FAILED', msg: '查询失败，请重试' };
  }
};
