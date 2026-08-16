from pathlib import Path

path = Path("packages/coding-agent/test/utils/changelog.test.ts")
source = path.read_text()
anchor = '\t\t\t\t\t\t\tNO_COLOR: "1",\n\t\t\t\t\t\t\tTERM: "xterm-256color",\n'
replacement = '\t\t\t\t\t\t\tNO_COLOR: "1",\n\t\t\t\t\t\t\tOMP_DESKTOP: "0",\n\t\t\t\t\t\t\tTERM: "xterm-256color",\n'
if anchor not in source:
    raise SystemExit("PTY changelog environment anchor not found")
path.write_text(source.replace(anchor, replacement, 1))
