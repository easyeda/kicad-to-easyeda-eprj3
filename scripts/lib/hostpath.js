'use strict';
/**
 * hostpath.js — 宿主（嘉立创EDA Pro）路径语法安全层。
 *
 * 客户端 pcb.js 路径解析器（build8）语义，自 V4.1.60 安装目录逆向：
 *   [x0, y0] 起点；'L',x,y 线段；'ARC',sweep,endX,endY 弧（扫角在前）；
 *   'C',…6 数贝塞尔（o+=7）。**裸数字复用上一 token**；未匹配 token 落
 *   default → throw "invalid rawData" —— 无 token 裸数字路径（path[2] 是数字）
 *   必炸。POUR/POLY path 还接受嵌套形式：外层数组的元素可为 ['R',x,y,w,h,0,0]
 *   描述符（R=[minX,maxY,w,h]，第二值=上缘）或 ['CIRCLE',cx,cy,r,1] 子路径。
 *
 * 本模块提供 build8 语义模拟（simBuild8）与记录级校验（validatePath /
 * validateRecords）：转换器在写盘前对每条带 path 的记录做验证，违规即抛错，
 * 使 token/收尾对一类事故在转换时暴露，而不是在客户端加载时爆炸。
 */

// 模拟 build8。返回 null=合法，否则返回错误原因字符串。
function simBuild8(e) {
  if (!Array.isArray(e) || e.length < 4) return 'path too short';
  if (typeof e[0] !== 'number' || typeof e[1] !== 'number') return 'first point not numeric';
  let o = 2, i;
  for (; o < e.length;) {
    if (typeof e[o] === 'string') i = e[o];
    else {
      if (i === undefined) return 'bare number before any token at #' + o;
      o -= 1;
    }
    if (i === 'L') {
      const s = e.slice(o + 1, o + 3);
      if (s.length !== 2 || !s.every(v => typeof v === 'number')) return 'bad L block at #' + o;
      o += 3;
    } else if (i === 'ARC') {
      const s = e.slice(o + 1, o + 4);
      if (s.length !== 3 || !s.every(v => typeof v === 'number')) return 'bad ARC block at #' + o;
      o += 4;
    } else if (i === 'C') {
      const s = e.slice(o + 1, o + 7);
      if (s.length !== 6 || !s.every(v => typeof v === 'number')) return 'bad C block at #' + o;
      o += 7;
    } else {
      return 'unknown token ' + JSON.stringify(i);
    }
  }
  return null;
}

// 记录级校验：POLY/POUR/REGION/FILL body.path。
// 接受三种已证实合法的形态：R 描述符（['R',minX,maxY,w,h,0,0]）、
// ['CIRCLE',cx,cy,r,1] 子路径、嵌套数组（逐元素递归校验）。
function validatePath(path) {
  if (path[0] === 'R') {
    if (path.length !== 7) return 'R descriptor needs 7 elements, got ' + path.length;
    return null;
  }
  if (Array.isArray(path[0])) {
    for (const sub of path) {
      if (!Array.isArray(sub)) return 'nested path element not an array';
      if (sub[0] === 'R') {
        if (sub.length !== 7) return 'R descriptor needs 7 elements, got ' + sub.length;
        continue;
      }
      const r = sub[0] === 'CIRCLE'
        ? (sub.length === 5 ? null : 'CIRCLE subpath needs 5 elements')
        : simBuild8(sub);
      if (r) return r;
    }
    return null;
  }
  return simBuild8(path);
}

// 遍历记录列表，返回第一个违规的 {type, id, reason}，全部合法返回 null。
function findViolation(records) {
  for (const r of records) {
    const p = r.body && r.body.path;
    if (!Array.isArray(p)) continue;
    const reason = validatePath(p);
    if (reason) return { type: (r.head && r.head.type) || r.type, id: JSON.stringify(r.head && r.head.id), reason };
  }
  return null;
}

module.exports = { simBuild8, validatePath, findViolation };
