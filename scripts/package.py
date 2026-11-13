"""Create a Decky ZIP from the already built plugin, without local user data."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
if not (root / "dist/index.js").is_file():
    raise SystemExit("Run pnpm build before packaging")
output = root / "out"
output.mkdir(exist_ok=True)
archive = output / f"ScreenshotUploader-{version}.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
    for name in ("plugin.json", "package.json", "main.py", "LICENSE", "README.md"):
        package.write(root / name, "DeckScreenshotManager/" + name)
    for path in sorted((root / "dist").rglob("*")):
        if path.is_file():
            package.write(path, "DeckScreenshotManager/" + str(path.relative_to(root)))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n")
print(archive)
