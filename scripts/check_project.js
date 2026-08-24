// scripts/check_project.js —— 上线前自动体检
// 检查项：页面四件套 / tabBar 图标 / 云函数前后端匹配 / 数据库集合引用
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let issues = [];
let passed = 0;

function ok(msg) { passed++; console.log('  [PASS] ' + msg); }
function fail(msg) { issues.push(msg); console.log('  [FAIL] ' + msg); }

// ---------- 1. 页面四件套 ----------
console.log('\n== 1. 页面四件套完整性 ==');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
(appJson.pages || []).forEach((page) => {
  const missing = ['js', 'wxml', 'wxss', 'json']
    .filter((ext) => !fs.existsSync(path.join(ROOT, page + '.' + ext)));
  if (missing.length === 0) ok('pages: ' + page);
  else fail('页面 ' + page + ' 缺少文件: ' + missing.join(','));
});

// ---------- 2. tabBar 图标 ----------
console.log('\n== 2. TabBar 图标 ==');
const tabBar = appJson.tabBar || {};
(tabBar.list || []).forEach((item) => {
  [item.iconPath, item.selectedIconPath].forEach((icon) => {
    if (!icon) return;
    if (fs.existsSync(path.join(ROOT, icon))) ok('图标存在: ' + icon);
    else fail('图标缺失: ' + icon);
  });
});

// ---------- 3. 云函数前后端匹配 ----------
console.log('\n== 3. 云函数前后端匹配 ==');
const cfDir = path.join(ROOT, 'cloudfunctions');
const deployed = fs.readdirSync(cfDir).filter((d) =>
  fs.existsSync(path.join(cfDir, d, 'index.js'))
);
const called = new Set();
function walk(dir) {
  if (fs.statSync(dir).isFile()) return scanFile(dir);
  fs.readdirSync(dir).forEach((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) return walk(p);
    return scanFile(p);
  });
}
function scanFile(p) {
  if (!p.endsWith('.js') || p.indexOf(path.join(ROOT, 'cloudfunctions')) === 0) return;
  const src = fs.readFileSync(p, 'utf8');
  const re = /callFunction\(\s*\{[^}]*name:\s*['"]([\w-]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) called.add(m[1]);
  const re2 = /callFunction\s*\(\s*name:\s*['"]([\w-]+)['"]/g;
  while ((m = re2.exec(src)) !== null) called.add(m[1]);
}
walk(path.join(ROOT, 'pages'));
walk(path.join(ROOT, 'utils'));
walk(path.join(ROOT, 'app.js'));

called.forEach((name) => {
  if (deployed.indexOf(name) >= 0) ok('前端调用「' + name + '」已实现');
  else fail('前端调用了「' + name + '」但 cloudfunctions 下没有实现');
});

// 云函数间调用（sendNotify）
const interCalled = [];
deployed.forEach((name) => {
  const src = fs.readFileSync(path.join(cfDir, name, 'index.js'), 'utf8');
  const re = /cloud\.callFunction\(\s*\{\s*name:\s*['"]([\w-]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) interCalled.push({ from: name, to: m[1] });
});
interCalled.forEach(({ from, to }) => {
  if (deployed.indexOf(to) >= 0) ok('云函数 ' + from + ' → ' + to + ' 已实现');
  else fail('云函数 ' + from + ' 调用了 ' + to + ' 但未实现');
});

// ---------- 4. 数据库集合引用 ----------
console.log('\n== 4. 数据库集合引用 ==');
const collections = new Set();
deployed.forEach((name) => {
  const src = fs.readFileSync(path.join(cfDir, name, 'index.js'), 'utf8');
  const re = /db\.collection\(['"]([\w]+)['"]\)/g;
  let m;
  while ((m = re.exec(src)) !== null) collections.add(m[1]);
});
collections.forEach((c) => ok('集合引用: ' + c));

// ---------- 5. 关键配置抽查 ----------
console.log('\n== 5. 关键配置抽查 ==');
// app.js 环境ID
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const envMatch = appJs.match(/env:\s*['"]([^'"]+)['"]/);
if (envMatch && envMatch[1] && envMatch[1].indexOf('替换') < 0 && envMatch[1] !== 'your-env-id') {
  ok('云开发环境ID已配置: ' + envMatch[1]);
} else {
  fail('app.js 云开发环境 ID 未配置（README 第二步）');
}
// project.config.json AppID
const projCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const appid = projCfg.appid || (projCfg.projectname && '') ;
if (projCfg.appid === 'wx0e1b01f2a3e33d55') ok('AppID 正确: ' + projCfg.appid);
else fail('project.config.json AppID 异常: ' + projCfg.appid);

// ---------- 汇总 ----------
console.log('\n================ 体检结果 ================');
console.log('通过: ' + passed + ' 项，问题: ' + issues.length + ' 项');
if (issues.length > 0) {
  console.log('\n需要处理的问题：');
  issues.forEach((s, i) => console.log('  ' + (i + 1) + '. ' + s));
  process.exit(1);
} else {
  console.log('全部通过，可以进入真机测试阶段 🎉');
}
