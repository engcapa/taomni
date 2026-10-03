/**
 * Install-command catalog for Language Servers settings.
 *
 * Rules:
 * - `command` must be copy-paste runnable (or clearly a multi-line shell script).
 * - Prefer package managers when the formula is reliable.
 * - When only archive downloads exist, point at a **real file URL** (or a folder
 *   that contains named archives), never a bare project root that only lists dirs.
 * - `note` holds prerequisites / caveats that are not part of the shell script.
 * - Split by OS only when the install path actually differs.
 */

export type LspInstallOs = "linux" | "macos" | "windows";

export interface LspInstallCommand {
  /** Primary copyable install line (or multi-line script). */
  command: string;
  /**
   * Prerequisites and caveats (JDK, PATH, “root page is only a directory list”, etc.).
   * Shown above the command block; not part of the clipboard payload by default.
   */
  note?: string;
}

export interface LspInstallGuide {
  /** One command for every OS — no OS labels in the UI. */
  shared?: LspInstallCommand;
  /** OS-specific variants; only include OSes that differ. */
  byOs?: Partial<Record<LspInstallOs, LspInstallCommand>>;
}

export interface ResolvedInstallLine {
  /** When null, the command is shared across platforms. */
  os: LspInstallOs | null;
  command: string;
  note?: string;
}

export interface ResolvedInstallGuide {
  /** True when more than one OS-specific line is shown. */
  multiOs: boolean;
  lines: ResolvedInstallLine[];
}

/** Eclipse JDT LS — real archive URLs (root /jdtls/ is only a folder index). */
const JDTLS_NOTE_COMMON =
  "Requires JDK 21+ (`java -version`). Current Eclipse JDT LS exits immediately on JDK 17. "
  + "Do not stop at https://download.eclipse.org/jdtls/ — that page only lists folders "
  + "(milestones/, snapshots/). Download a .tar.gz from snapshots or a version under milestones. "
  + "After install, `jdtls` must be on PATH; open a Maven/Gradle project for full intelligence.";

const JDTLS_LINUX = {
  note: JDTLS_NOTE_COMMON + " Linux uses shared `config_linux`.",
  command: `# JDK 21+ required (current JDT LS)
java -version

mkdir -p "$HOME/.local/share/jdtls" "$HOME/.local/bin" "$HOME/.cache/jdtls"

# Direct file (not the /jdtls/ root). "latest" always points at a real tar.gz.
# Prefer milestones for stability: open
#   https://download.eclipse.org/jdtls/milestones/
# pick the highest version folder, then download jdt-language-server-*.tar.gz inside it.
curl -fL -o /tmp/jdtls.tar.gz \\
  "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz"

# Wipe previous extract so config_* dirs stay clean
rm -rf "$HOME/.local/share/jdtls"/*
tar -xzf /tmp/jdtls.tar.gz -C "$HOME/.local/share/jdtls"

cat > "$HOME/.local/bin/jdtls" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
JDTLS_HOME="\${JDTLS_HOME:-\$HOME/.local/share/jdtls}"
LAUNCHER=\$(echo "\$JDTLS_HOME"/plugins/org.eclipse.equinox.launcher_*.jar)
DATA="\${XDG_CACHE_HOME:-\$HOME/.cache}/jdtls/ws/\$(printf '%s' "\$PWD" | sha256sum | cut -c1-16)"
mkdir -p "\$DATA"
# Match upstream jdtls.py: shared config + JPMS opens (not plain -configuration).
exec java \\
  -Declipse.application=org.eclipse.jdt.ls.core.id1 \\
  -Dosgi.bundles.defaultStartLevel=4 \\
  -Declipse.product=org.eclipse.jdt.ls.core.product \\
  -Dosgi.checkConfiguration=true \\
  -Dosgi.sharedConfiguration.area="\$JDTLS_HOME/config_linux" \\
  -Dosgi.sharedConfiguration.area.readOnly=true \\
  -Dosgi.configuration.cascaded=true \\
  -Dlog.level=ERROR \\
  -Xms1G -Xmx1G \\
  --add-modules=ALL-SYSTEM \\
  --add-opens java.base/java.util=ALL-UNNAMED \\
  --add-opens java.base/java.lang=ALL-UNNAMED \\
  -jar "\$LAUNCHER" \\
  -data "\$DATA" \\
  "$@"
EOF
chmod +x "$HOME/.local/bin/jdtls"

# Put ~/.local/bin on PATH for this shell (and persist if missing)
export PATH="$HOME/.local/bin:$PATH"
grep -qs '.local/bin' "$HOME/.bashrc" 2>/dev/null \\
  || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"

command -v jdtls && echo "OK: jdtls is on PATH"
# Optional Arch package (may lag): sudo pacman -S jdtls
`.trim(),
} satisfies LspInstallCommand;

const JDTLS_MACOS = {
  note: JDTLS_NOTE_COMMON + " Prefer Homebrew when available (config_mac is handled by the formula).",
  command: `# JDK 21+ required (current JDT LS)
java -version

# Recommended
brew install jdtls
command -v jdtls

# Manual alternative (if brew is unavailable):
# mkdir -p "$HOME/.local/share/jdtls" "$HOME/.local/bin"
# curl -fL -o /tmp/jdtls.tar.gz \\
#   "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz"
# tar -xzf /tmp/jdtls.tar.gz -C "$HOME/.local/share/jdtls"
# # wrapper same as Linux but use shared config_mac (see Linux script)
`.trim(),
} satisfies LspInstallCommand;

const JDTLS_WINDOWS = {
  note: JDTLS_NOTE_COMMON
    + " Windows: install JDK 21+ (Temurin/Oracle). Taomni launches jdtls via java -jar (shared config_win)."
    + " Ensure `java` and the jdtls.cmd directory are on PATH so Settings can detect the install.",
  command: `# PowerShell — JDK 21+ required (JDK 17 will fail: process exits immediately)
java -version

$JdtlsHome = Join-Path $env:LOCALAPPDATA "jdtls"
$Bin = Join-Path $env:LOCALAPPDATA "jdtls-bin"
New-Item -ItemType Directory -Force -Path $JdtlsHome, $Bin | Out-Null

# Direct archive URL (root /jdtls/ is only a directory listing)
$Url = "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz"
$Tar = Join-Path $env:TEMP "jdtls.tar.gz"
Invoke-WebRequest -Uri $Url -OutFile $Tar

# Needs tar (Windows 10+ has bsdtar)
tar -xzf $Tar -C $JdtlsHome

$Launcher = Get-ChildItem (Join-Path $JdtlsHome "plugins\\org.eclipse.equinox.launcher_*.jar") | Select-Object -First 1
if (-not $Launcher) { throw "launcher jar not found under $JdtlsHome\\plugins" }

@'
@echo off
setlocal
set JDTLS_HOME=%LOCALAPPDATA%\\jdtls
for %%F in ("%JDTLS_HOME%\\plugins\\org.eclipse.equinox.launcher_*.jar") do set LAUNCHER=%%F
set DATA=%LOCALAPPDATA%\\jdtls-ws\\%CD:\\=_%
if not exist "%DATA%" mkdir "%DATA%"
rem Match upstream jdtls.py (shared config + JPMS opens). Do not use plain -configuration.
java -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product -Dosgi.checkConfiguration=true -Dosgi.sharedConfiguration.area="%JDTLS_HOME%\\config_win" -Dosgi.sharedConfiguration.area.readOnly=true -Dosgi.configuration.cascaded=true -Dlog.level=ERROR -Xms1G -Xmx1G --add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED -jar "%LAUNCHER%" -data "%DATA%" %*
'@ | Set-Content -Encoding ASCII (Join-Path $Bin "jdtls.cmd")

# Add %LOCALAPPDATA%\\jdtls-bin to User PATH, then open a new terminal
# Also set JAVA_HOME to a JDK 21+ install if java -version is still 17.
Write-Host "Created $Bin\\jdtls.cmd — add this folder to User PATH, then run: where jdtls"
Write-Host "Taomni also needs JDK 21+: winget install EclipseAdoptium.Temurin.21.JDK"
`.trim(),
} satisfies LspInstallCommand;

const GUIDES: Record<string, LspInstallGuide> = {
  "typescript-language-server": {
    shared: {
      note:
        "Requires Node.js 18+ and npm. Installs the `typescript-language-server` binary "
        + "(uses the TypeScript compiler API). Ensure npm global bin is on PATH "
        + "(`npm prefix -g`/bin).",
      command: `npm install -g typescript typescript-language-server

# Verify
command -v typescript-language-server || where typescript-language-server
typescript-language-server --version
`.trim(),
    },
  },

  "rust-analyzer": {
    shared: {
      note:
        "Requires a Rust toolchain via rustup (https://rustup.rs). "
        + "After install, the binary is usually ~/.cargo/bin/rust-analyzer — keep that on PATH.",
      command: `# Install rustup first if needed: https://rustup.rs
rustup component add rust-analyzer

# Verify
command -v rust-analyzer || rustup which rust-analyzer
rust-analyzer --version
`.trim(),
    },
  },

  pyright: {
    shared: {
      note:
        "Requires Node.js + npm. Taomni launches `pyright-langserver --stdio` "
        + "(provided by the `pyright` package). Ensure npm global bin is on PATH.",
      command: `npm install -g pyright

# Verify (binary name is pyright-langserver, not pyright alone for LSP)
command -v pyright-langserver || where pyright-langserver
pyright-langserver --version
`.trim(),
    },
  },

  gopls: {
    shared: {
      note:
        "Requires Go 1.20+ (https://go.dev/dl/). "
        + "Installs into $(go env GOPATH)/bin — add that directory to PATH.",
      command: `go install golang.org/x/tools/gopls@latest

# Ensure GOPATH/bin is on PATH (common default ~/go/bin)
export PATH="$(go env GOPATH)/bin:$PATH"

# Verify
command -v gopls
gopls version
`.trim(),
    },
  },

  jdtls: {
    byOs: {
      linux: JDTLS_LINUX,
      macos: JDTLS_MACOS,
      windows: JDTLS_WINDOWS,
    },
  },

  clangd: {
    byOs: {
      linux: {
        note:
          "clangd is part of LLVM. Prefer the distro package first. "
          + "For CMake projects, generate compile_commands.json and place/link it at the project root.",
        command: `# Debian / Ubuntu
sudo apt update
sudo apt install -y clangd

# Fedora
# sudo dnf install clang-tools-extra

# Arch
# sudo pacman -S clang

# Verify
command -v clangd
clangd --version
`.trim(),
      },
      macos: {
        note:
          "Homebrew's llvm formula installs clangd, but it may not be linked on default PATH. "
          + "Add $(brew --prefix llvm)/bin to PATH, or create a symlink.",
        command: `brew install llvm

# clangd is usually here (not always linked into /opt/homebrew/bin)
echo "clangd at: $(brew --prefix llvm)/bin/clangd"
export PATH="$(brew --prefix llvm)/bin:$PATH"

# Optional permanent symlink:
# ln -sf "$(brew --prefix llvm)/bin/clangd" /opt/homebrew/bin/clangd

command -v clangd
clangd --version
`.trim(),
      },
      windows: {
        note:
          "Install LLVM so `clangd.exe` is on PATH. "
          + "After winget/installer, open a new terminal and run `where clangd`.",
        command: `winget install --id LLVM.LLVM -e

# Alternative: download Windows installer from https://github.com/llvm/llvm-project/releases
# or https://llvm.org/builds/ and tick "Add LLVM to the system PATH".

where clangd
clangd --version
`.trim(),
      },
    },
  },

  "kotlin-language-server": {
    byOs: {
      macos: {
        note:
          "Requires a JDK on PATH. Homebrew formula provides the `kotlin-language-server` binary. "
          + "Android/Gradle multi-module support is weaker than IntelliJ.",
        command: `brew install kotlin-language-server

command -v kotlin-language-server
kotlin-language-server --help | head
`.trim(),
      },
      linux: {
        note:
          "Requires JDK. Official release asset is a single server.zip "
          + "(https://github.com/fwcd/kotlin-language-server/releases). "
          + "Extract and put bin/kotlin-language-server on PATH.",
        command: `# Installs latest server.zip from GitHub Releases (asset name: server.zip)
set -euo pipefail
VER=$(curl -fsSL https://api.github.com/repos/fwcd/kotlin-language-server/releases/latest \\
  | sed -n 's/.*"tag_name": "\\([^"]*\\)".*/\\1/p' | head -1)
test -n "$VER"
DEST="$HOME/.local/share/kotlin-language-server"
BIN="$HOME/.local/bin"
mkdir -p "$DEST" "$BIN"
curl -fL -o /tmp/kotlin-ls-server.zip \\
  "https://github.com/fwcd/kotlin-language-server/releases/download/\${VER}/server.zip"
rm -rf "$DEST"/*
unzip -qo /tmp/kotlin-ls-server.zip -d "$DEST"
# Layout is typically server/bin/kotlin-language-server
KLS=$(find "$DEST" -type f -name kotlin-language-server | head -1)
test -n "$KLS"
ln -sfn "$KLS" "$BIN/kotlin-language-server"
chmod +x "$KLS"
export PATH="$BIN:$PATH"
command -v kotlin-language-server
`.trim(),
      },
      windows: {
        note:
          "Requires JDK. Download server.zip from "
          + "https://github.com/fwcd/kotlin-language-server/releases "
          + "(asset name is always server.zip). Extract and add the bin folder to PATH.",
        command: `# PowerShell
$Rel = Invoke-RestMethod https://api.github.com/repos/fwcd/kotlin-language-server/releases/latest
$Asset = $Rel.assets | Where-Object { $_.name -eq "server.zip" } | Select-Object -First 1
if (-not $Asset) { throw "server.zip not found on latest release" }
$Dest = Join-Path $env:LOCALAPPDATA "kotlin-language-server"
$Zip = Join-Path $env:TEMP "kotlin-ls-server.zip"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Zip
Expand-Archive -Path $Zip -DestinationPath $Dest -Force
Get-ChildItem -Recurse $Dest -Filter kotlin-language-server*.bat
Write-Host "Add the folder containing kotlin-language-server.bat to User PATH"
`.trim(),
      },
    },
  },

  metals: {
    byOs: {
      macos: {
        note:
          "Metals is the Scala language server. Requires Java + a build tool (sbt/mill/bloop). "
          + "Open an sbt/mill project root so Metals can import.",
        command: `brew install metals

# Alternative via Coursier (https://get-coursier.io/):
# brew install coursier/formulas/coursier && cs install metals

command -v metals
metals --version
`.trim(),
      },
      linux: {
        note:
          "Requires Java. Easiest cross-distro path is Coursier "
          + "(https://get-coursier.io/docs/cli-installation). "
          + "Open an sbt/mill project for import.",
        command: `# Install Coursier CLI if missing: https://get-coursier.io/docs/cli-installation
# Example (Linux x86_64):
# curl -fL "https://github.com/coursier/launchers/raw/master/cs-x86_64-pc-linux.gz" | gzip -d > cs
# chmod +x cs && ./cs setup

cs install metals

# Ensure coursier bin is on PATH (often ~/.local/share/coursier/bin)
export PATH="$HOME/.local/share/coursier/bin:$PATH"
command -v metals
metals --version
`.trim(),
      },
      windows: {
        note:
          "Requires Java + Coursier (https://get-coursier.io/). "
          + "After cs setup, open a new shell so PATH includes Coursier apps.",
        command: `# Install Coursier first: https://get-coursier.io/docs/cli-installation
cs install metals
where metals
metals --version
`.trim(),
      },
    },
  },

  "csharp-ls": {
    shared: {
      note:
        "Requires .NET SDK 6+ (https://dotnet.microsoft.com/download). "
        + "Global tools install to a user tools directory that must be on PATH "
        + "(`dotnet tool list -g` shows the path).",
      command: `dotnet tool install -g csharp-ls

# Update later:
# dotnet tool update -g csharp-ls

# Verify
dotnet tool list -g
command -v csharp-ls || where csharp-ls
`.trim(),
    },
  },

  omnisharp: {
    byOs: {
      macos: {
        note:
          "OmniSharp is a fallback C# server. Prefer csharp-ls when it works. "
          + "Homebrew formula provides the `omnisharp` binary.",
        command: `brew install omnisharp

command -v omnisharp
omnisharp --version
# Taomni launches with: omnisharp --languageserver
`.trim(),
      },
      linux: {
        note:
          "Download a platform-specific archive from OmniSharp-roslyn releases "
          + "(real assets, e.g. omnisharp-linux-x64-net6.0.tar.gz). "
          + "https://github.com/OmniSharp/omnisharp-roslyn/releases",
        command: `# Example: latest Linux x64 (net6.0). Change asset name for arm64/musl.
set -euo pipefail
DEST="$HOME/.local/share/omnisharp"
BIN="$HOME/.local/bin"
mkdir -p "$DEST" "$BIN"
TAG=$(curl -fsSL https://api.github.com/repos/OmniSharp/omnisharp-roslyn/releases/latest \\
  | sed -n 's/.*"tag_name": "\\([^"]*\\)".*/\\1/p' | head -1)
ASSET="omnisharp-linux-x64-net6.0.tar.gz"
curl -fL -o /tmp/omnisharp.tgz \\
  "https://github.com/OmniSharp/omnisharp-roslyn/releases/download/\${TAG}/\${ASSET}"
tar -xzf /tmp/omnisharp.tgz -C "$DEST"
# Binary is typically named OmniSharp or run script at root of extract
if [ -x "$DEST/OmniSharp" ]; then ln -sfn "$DEST/OmniSharp" "$BIN/omnisharp"
elif [ -x "$DEST/run" ]; then ln -sfn "$DEST/run" "$BIN/omnisharp"
else echo "Inspect $DEST and symlink the OmniSharp binary to $BIN/omnisharp"; ls -la "$DEST"; fi
export PATH="$BIN:$PATH"
command -v omnisharp
# Taomni: omnisharp --languageserver
`.trim(),
      },
      windows: {
        note:
          "Download a Windows asset from "
          + "https://github.com/OmniSharp/omnisharp-roslyn/releases "
          + "(e.g. omnisharp-win-x64-net6.0.zip). Extract and put OmniSharp.exe on PATH as omnisharp.",
        command: `# PowerShell — adjust asset for arm64 if needed
$Rel = Invoke-RestMethod https://api.github.com/repos/OmniSharp/omnisharp-roslyn/releases/latest
$Name = "omnisharp-win-x64-net6.0.zip"
$Asset = $Rel.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
if (-not $Asset) {
  Write-Host "Available assets:"; $Rel.assets | ForEach-Object { $_.name }
  throw "Asset $Name not found — pick a win-* asset from the list above"
}
$Dest = Join-Path $env:LOCALAPPDATA "omnisharp"
$Zip = Join-Path $env:TEMP $Name
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Zip
Expand-Archive -Path $Zip -DestinationPath $Dest -Force
Get-ChildItem $Dest -Filter OmniSharp.exe -Recurse
Write-Host "Add the folder containing OmniSharp.exe to PATH (or rename/copy as omnisharp.exe)"
Write-Host "Taomni launches: omnisharp --languageserver"
`.trim(),
      },
    },
  },

  "sourcekit-lsp": {
    byOs: {
      macos: {
        note:
          "sourcekit-lsp ships with Xcode or the Swift toolchain. "
          + "After Xcode install, accept the license and ensure CLI tools work.",
        command: `# Install Xcode from App Store, then:
xcode-select --install
sudo xcodebuild -license accept

# Verify
xcrun sourcekit-lsp --help
# or
command -v sourcekit-lsp
`.trim(),
      },
      linux: {
        note:
          "Install an official Swift toolchain from https://www.swift.org/install/ "
          + "(pick your distro). The package includes sourcekit-lsp. "
          + "There is no universal one-liner for every distro.",
        command: `# 1) Open https://www.swift.org/install/ and download the toolchain for your distro
#    (Ubuntu/Debian/Fedora packages or tarball — follow the site's steps).
# 2) Ensure the toolchain bin dir is on PATH (often /usr/bin or ~/swift/.../usr/bin)
# 3) Verify:
command -v sourcekit-lsp
sourcekit-lsp --help
`.trim(),
      },
      windows: {
        note:
          "Swift on Windows is limited. Install from https://www.swift.org/install/windows/ "
          + "and ensure sourcekit-lsp.exe is on PATH. Many workflows stay on macOS/Linux.",
        command: `# 1) Download & install Swift for Windows from:
#    https://www.swift.org/install/windows/
# 2) Open a new terminal after install
where sourcekit-lsp
sourcekit-lsp --help
`.trim(),
      },
    },
  },
};

/** Detect host OS for highlighting the relevant install row. */
export function detectHostOs(): LspInstallOs | null {
  if (typeof navigator === "undefined") return null;
  const platform = (navigator.platform || "").toLowerCase();
  const ua = (navigator.userAgent || "").toLowerCase();
  if (platform.includes("mac") || ua.includes("mac os")) return "macos";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (
    platform.includes("linux")
    || ua.includes("linux")
    || platform.includes("x11")
  ) {
    return "linux";
  }
  return null;
}

export function installGuideForCommandId(commandId: string): LspInstallGuide | null {
  return GUIDES[commandId] ?? null;
}

/**
 * Resolve a displayable install guide for a language-server command.
 * Prefers the catalog; falls back to the backend `installHint` as a single shared line.
 */
export function resolveInstallGuide(
  commandId: string,
  backendHint?: string | null,
): ResolvedInstallGuide | null {
  const guide = installGuideForCommandId(commandId);
  if (guide) {
    return materializeGuide(guide);
  }
  const hint = backendHint?.trim();
  if (!hint) return null;
  return {
    multiOs: false,
    lines: [{ os: null, command: hint }],
  };
}

function materializeGuide(guide: LspInstallGuide): ResolvedInstallGuide | null {
  if (guide.shared && !guide.byOs) {
    return {
      multiOs: false,
      lines: [{
        os: null,
        command: guide.shared.command,
        note: guide.shared.note,
      }],
    };
  }

  if (guide.byOs) {
    const order: LspInstallOs[] = ["linux", "macos", "windows"];
    const lines: ResolvedInstallLine[] = [];
    for (const os of order) {
      const entry = guide.byOs[os] ?? guide.shared;
      if (!entry) continue;
      lines.push({
        os,
        command: entry.command,
        note: entry.note,
      });
    }
    // Collapse to shared if every OS resolved to the exact same command+note.
    if (lines.length > 1) {
      const first = lines[0];
      const allSame = lines.every(
        (line) => line.command === first.command && line.note === first.note,
      );
      if (allSame) {
        return {
          multiOs: false,
          lines: [{ os: null, command: first.command, note: first.note }],
        };
      }
    }
    if (lines.length === 0) return null;
    return { multiOs: lines.length > 1, lines };
  }

  if (guide.shared) {
    return {
      multiOs: false,
      lines: [{
        os: null,
        command: guide.shared.command,
        note: guide.shared.note,
      }],
    };
  }
  return null;
}

export function osLabel(os: LspInstallOs): string {
  switch (os) {
    case "linux": return "Linux";
    case "macos": return "macOS";
    case "windows": return "Windows";
  }
}
