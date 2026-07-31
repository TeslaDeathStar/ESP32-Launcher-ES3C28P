import subprocess
from pathlib import Path
import sys

try:
    Import("env")  # type: ignore
except NameError:
    env = None

if env is not None and env.get("PROJECT_DIR"):
    ROOT = Path(env.get("PROJECT_DIR"))
else:
    ROOT = Path(__file__).resolve().parent.parent

SUBMODULE_CMD = ["git", "submodule", "update", "--init", "--recursive"]


def run_command(cmd, cwd):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Command failed: {' '.join(cmd)}")
        print(result.stdout)
        print(result.stderr)
        sys.exit(result.returncode)
    return result.stdout.strip()


print("Checking submodules...")
if not (ROOT / ".git").exists():
    if (ROOT / "lib_modules").exists():
        print("No .git directory found; using existing lib_modules directory.")
    else:
        print("No .git directory found and lib_modules directory is missing.")
        print("Use a git clone with submodules or restore the lib_modules directory.")
        sys.exit(1)
elif not (ROOT / "lib_modules").exists():
    print("lib_modules directory not found. Initializing submodules...")
    run_command(SUBMODULE_CMD, ROOT)
else:
    print("Initializing missing submodules and updating existing ones...")
    run_command(SUBMODULE_CMD, ROOT)
print("Submodules are ready.")
