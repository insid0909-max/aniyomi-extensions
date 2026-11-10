#!/usr/bin/env python3
"""애니요미 시험 APK 빌드 준비 (test-apk 가지의 CI 에서만 실행, 저장소 파일은 CI 작업 공간 안에서만 바뀜).

정식 APK 와 같이 설치돼도 서로 덮어쓰거나 섞이지 않게:
1. 패키지 이름 뒤에 ".test"  (common.gradle applicationIdSuffix)
2. 앱 이름 "TVroom (시험)" (매니페스트 label) · "Aniyomi: TVroom (test)"
3. 소스 이름 앞에 "[시험] " → 소스 번호(id)·설정·서재가 정식판과 따로
   (override val name 줄의 글자, when(kind) 분기 글자, BASE_NAME, generateId("…") 의 이름)
"""
import pathlib
import re
import sys

PREFIX = "[시험] "
root = pathlib.Path(__file__).resolve().parent.parent

g = root / "common.gradle"
s = g.read_text(encoding="utf-8")
a = 'applicationIdSuffix "." + project.name'
assert a in s, "common.gradle applicationIdSuffix 모양이 바뀜"
s = s.replace(a, a + ' + ".test"', 1)
b = 'appName : "Aniyomi: $extName",'
assert b in s, "common.gradle appName 모양이 바뀜"
s = s.replace(b, 'appName : "Aniyomi: $extName (test)",', 1)
g.write_text(s, encoding="utf-8")

# 앱 목록에 보이는 이름(매니페스트 android:label) 뒤에 " (시험)"
for mf in sorted((root / "src" / "ko").glob("*/AndroidManifest.xml")):
    t = mf.read_text(encoding="utf-8")
    t2 = re.sub(r'android:label="([^"@]+?)(?<! \(시험\))"', r'android:label="\1 (시험)"', t)
    if t2 != t:
        mf.write_text(t2, encoding="utf-8")
        print(f"{mf.relative_to(root)}: 앱 이름에 (시험)")

LIT = re.compile(r'"(?!\$)(?=[^"])')  # $label 로 시작하는 오류 소스 이름은 그대로


def prefix_literals(line: str) -> str:
    out, i = [], 0
    in_str = False
    while i < len(line):
        c = line[i]
        if c == '"' and (i == 0 or line[i - 1] != "\\"):
            if not in_str and LIT.match(line, i) and not line.startswith('"""', i) and not line[i + 1 :].startswith(PREFIX):
                out.append('"' + PREFIX)
                in_str = True
                i += 1
                continue
            in_str = not in_str
        out.append(c)
        i += 1
    return "".join(out)


changed = 0
for kt in sorted((root / "src").rglob("*.kt")):
    text = kt.read_text(encoding="utf-8")
    lines = text.split("\n")
    in_when = False
    for n, line in enumerate(lines):
        new = line
        if re.search(r"override val name\s*=", line):
            if re.search(r"override val name\s*=\s*when", line):
                in_when = True
            elif "$label" not in line:
                new = prefix_literals(line)
        elif in_when:
            if line.strip() == "}":
                in_when = False
            elif "->" in line:
                head, tail = line.split("->", 1)
                new = head + "->" + prefix_literals(tail)
        if re.search(r'const val BASE_NAME\s*=\s*"', line):
            new = prefix_literals(line)
        new = re.sub(r'generateId\("(?!\[)', 'generateId("' + PREFIX, new)
        if new != line:
            lines[n] = new
            changed += 1
            print(f"{kt.relative_to(root)}:{n + 1}: {new.strip()}")
    kt.write_text("\n".join(lines), encoding="utf-8")

# modules.txt 에 "sites=이름,이름" 이 있으면 그 모듈 시험 APK 에는 그 사이트만 (이름에 그 글자가 든 소스, 오류 소스는 남김)
for raw in (root / "test-apk" / "modules.txt").read_text(encoding="utf-8").splitlines():
    parts = raw.split()
    if not parts or parts[0].startswith("#"):
        continue
    sites = next((p[6:] for p in parts if p.startswith("sites=")), "")
    keep = [x.strip() for x in sites.split(",") if x.strip()]
    if not keep:
        continue
    facs = list((root / "src" / "ko" / parts[0]).rglob("*Factory.kt"))
    assert facs, f"{parts[0]} 의 Factory 파일을 못 찾음"
    for fac in facs:
        t = fac.read_text(encoding="utf-8")
        mark = "override fun createSources()"
        if mark not in t:
            continue
        names = ", ".join('"' + k.replace('"', "") + '"' for k in keep)
        t = t.replace(
            mark,
            "override fun createSources(): List<AnimeSource> = createSourcesAll().filter { s ->\n"
            f"        listOf({names}).any {{ s.name.contains(it) }} || s.name.contains(\"오류\")\n"
            "    }\n\n    private fun createSourcesAll()",
            1,
        )
        fac.write_text(t, encoding="utf-8")
        print(f"{fac.relative_to(root)}: 시험할 사이트만 → {keep}")

print(f"바뀐 줄 {changed}개")
if changed == 0:
    sys.exit("소스 이름을 하나도 못 바꿈 — 확인 필요")
