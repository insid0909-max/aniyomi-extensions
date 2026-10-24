// changelog.json → 업데이트내역.md (사람이 읽는 전체 업데이트 내역 페이지)
// 사용: node changelog.js <changelog.json> <업데이트내역.md> (감시 작업이 주소를 바꾸면 자동으로 내역 추가)
const fs = require("fs");

function render(data) {
    const names = data.names || {};
    const rows = [];
    for (const [key, list] of Object.entries(data.items || {})) {
        for (const n of list || []) if (n && n.t) rows.push({ d: n.d || "", t: n.t, name: names[key] || key });
    }
    rows.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    const out = ["# 업데이트 내역", "", "확장앱 필터 화면 맨 위 📝 줄에는 소스마다 최근 3개가 보입니다. 이 페이지는 전체 내역입니다.", ""];
    let day = null;
    for (const r of rows) {
        if (r.d !== day) {
            day = r.d;
            out.push(`## ${day}`, "");
        }
        out.push(`- **${r.name}**: ${r.t}`);
        const next = rows[rows.indexOf(r) + 1];
        if (!next || next.d !== day) out.push("");
    }
    return out.join("\n");
}

/** 새 내역을 맨 앞에 넣음 (같은 날 같은 글은 한 번만) */
function addNote(data, key, date, text) {
    data.items = data.items || {};
    const list = (data.items[key] = data.items[key] || []);
    if (!list.some((n) => n.d === date && n.t === text)) list.unshift({ d: date, t: text });
    return data;
}

module.exports = { render, addNote };

if (require.main === module) {
    const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    fs.writeFileSync(process.argv[3], render(data));
}
