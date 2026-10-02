"""User-run hidden credential entry. No network, account changes, or paid activation."""
import getpass
import os
from pathlib import Path
import re
import sys


def main():
    if not sys.stdin.isatty():
        raise ValueError("Run this yourself in a local terminal; hidden key entry requires a TTY.")
    destination = Path(__file__).resolve().parent.parent / ".env.openrouter"
    if destination.exists():
        raise ValueError(".env.openrouter already exists; no file was read or changed. Edit it privately if needed.")
    print("Save an existing authorized OpenRouter key privately. No key is created and no service is contacted.")
    print("Future sessions send transcript/history to OpenRouter and Google AI Studio; Eleven speech uses its separate existing setup.")
    print("Paid OpenRouter usage remains DISABLED. Confirm credits and budget before explicitly enabling it later.")
    if input("Type SETUP to save an existing key locally: ").strip() != "SETUP":
        print("Cancelled. No file written.")
        return
    key = getpass.getpass("Existing OpenRouter API key (hidden): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,512}", key):
        raise ValueError("Invalid key format. No file written.")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write("# Private; never share or commit. Paid activation is a separate decision.\n")
        file.write(f"OPENROUTER_API_KEY={key}\nOPENROUTER_ENABLED=0\n")
    print("Saved with owner-only permissions. No existing voice setup was read or changed.")
    print("After credits/budget approval, see README for explicit activation and idle-only launch on port 4319.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled. No credentials displayed.")
        sys.exit(1)
    except (ValueError, OSError) as error:
        print(str(error) if isinstance(error, ValueError) else "Could not create private file; no existing file overwritten.", file=sys.stderr)
        sys.exit(1)
