# TaOffice Media third-party source

The TaOffice Media native host dynamically links FFmpeg 9.1 under LGPL 2.1 or
later. The FFmpeg libraries include the BSD-licensed libvpx, Opus and OpenH264
codecs. This package includes the license notices and the FFmpeg 9.1 source
archive. The pinned vcpkg ports provide the applied patches, dependency source
versions, checksums and build commands.

- [FFmpeg 9.1 source](https://github.com/FFmpeg/FFmpeg/tree/n9.1)
- [FFmpeg build recipe and patches](https://github.com/microsoft/vcpkg/tree/ba33ef1a2fb3c6519e819cd767bb8fd1677f1323/ports/ffmpeg)
- [libvpx source and build recipe](https://github.com/microsoft/vcpkg/tree/ba33ef1a2fb3c6519e819cd767bb8fd1677f1323/ports/libvpx)
- [Opus source and build recipe](https://github.com/microsoft/vcpkg/tree/ba33ef1a2fb3c6519e819cd767bb8fd1677f1323/ports/opus)
- [OpenH264 source and build recipe](https://github.com/microsoft/vcpkg/tree/ba33ef1a2fb3c6519e819cd767bb8fd1677f1323/ports/openh264)
- [TaOffice Media packaging scripts](https://github.com/engcapa/taomni/tree/main/src-tauri/plugins/taoffice-video/packaging)

From a checkout matching the module version, run
`python src-tauri/plugins/taoffice-video/packaging/prepare.py <platform>`
with the platform SDK and libclang installed. The script prints the FFmpeg
installation prefix to use as `FFMPEG_DIR`. Compile the host with
`cargo build --manifest-path src-tauri/Cargo.toml --release --locked -p taomni-plugin-taoffice-video`
and stage the host with the adjacent rebuilt libraries. Linux packages target
Ubuntu 22.04. macOS packages target macOS 11.0 or later, with libraries and the
host signed after relocation.
