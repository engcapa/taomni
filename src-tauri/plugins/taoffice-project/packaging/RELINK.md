# Rebuild the TaOffice Project host

The Project host statically links mpxj-rs under the GNU Lesser General Public License, version 2.1 or later. This directory contains the Cargo source archive used in the build and its license. The host, SDK, protocol, workspace manifest and dependency lockfile for this package are available at https://github.com/engcapa/taomni/tree/@SOURCE_SHA@.

With Git, Rust 1.94 or later and the native compiler for your platform, run the following commands from a writable development directory. Replace `/path/to/licenses/mpxj-rs` with this directory's absolute path. On Windows, Git Bash supports the same commands.

```sh
git clone https://github.com/engcapa/taomni.git
cd taomni
git checkout --detach @SOURCE_SHA@
mkdir mpxj-source
tar -xf /path/to/licenses/mpxj-rs/@ARCHIVE@ -C mpxj-source
```

Edit the library under `mpxj-source/@LIBRARY@`. From the root of the checkout, build and run the host tests against that copy.

```sh
cargo build --manifest-path src-tauri/Cargo.toml --release -p taomni-plugin-taoffice-project --config 'patch.crates-io.mpxj-rs.path="mpxj-source/@LIBRARY@"'
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-plugin-taoffice-project --config 'patch.crates-io.mpxj-rs.path="mpxj-source/@LIBRARY@"'
```

Cargo writes the rebuilt host under `src-tauri/target/release/` and updates the development checkout's lockfile to identify the local library. The application communicates with this host over its standard input and output.
