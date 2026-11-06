import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve("@xterm/addon-webgl"));

// Execute the installed package's compiled methods without constructing a GPU.
// Real pixels belong to TC-TERM-RENDER-001 on hosted QA. Vite uses ESM, while
// other consumers can use CJS, so both pinned entrypoints need the same fix.
function method(source, name) {
  const start = source.search(new RegExp(`\\b${name}\\([^()]*\\)\\{`));
  assert(start >= 0, `${name} must exist in the pinned runtime`);
  const brace = source.indexOf("{", start);
  let depth = 1;
  let end = brace + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  // Only the selected method from the trusted pinned dependency is evaluated.
  return new Function(`return ({${source.slice(start, end)}}).${name}`)();
}

function spy() {
  const calls = [];
  const fn = (...args) => calls.push(args);
  fn.calls = calls;
  return fn;
}

for (const entrypoint of ["addon-webgl.js", "addon-webgl.mjs"]) {
  describe(`WebGL atlas backport (${entrypoint})`, () => {
    const source = readFileSync(join(directory, entrypoint), "utf8");

    it("invalidates each shared owner once after clear and after atlas replacement", () => {
      const page = { currentRow: { x: 20, y: 10 }, clear: spy() };
      const atlas = {
        _pages: [page], _cacheMap: { clear: spy() },
        _cacheMapCombined: { clear: spy() }, _didWarmUp: true,
        _pageLayoutVersion: 0,
        get pageLayoutVersion() { return this._pageLayoutVersion; },
      };
      const beginFrame = method(source, "beginFrame");
      const setAtlas = method(source, "setAtlas");
      const owners = Array.from({ length: 3 }, () => ({
        _atlas: atlas, _lastSeenPageLayoutVersion: -1, _atlasTextures: [{ version: 8 }],
      }));
      for (const owner of owners) {
        assert.equal(beginFrame.call(owner), true);
        assert.equal(beginFrame.call(owner), false);
      }
      method(source, "clearTexture").call(atlas);
      assert.equal(page.clear.calls.length, 1);
      assert.equal(atlas._cacheMap.clear.calls.length, 1);
      assert.equal(atlas._cacheMapCombined.clear.calls.length, 1);
      assert.equal(atlas._didWarmUp, false);
      assert.equal(atlas.pageLayoutVersion, 1);
      // One owner's frame must not consume another owner's invalidation.
      for (const owner of owners) {
        assert.equal(beginFrame.call(owner), true);
        assert.equal(beginFrame.call(owner), false);
      }
      const replacement = { ...atlas, _pageLayoutVersion: 1, pageLayoutVersion: 1 };
      setAtlas.call(owners[0], replacement);
      assert.equal(owners[0]._atlasTextures[0].version, -1);
      assert.equal(beginFrame.call(owners[0]), true);
      assert.equal(beginFrame.call(owners[0]), false);
    });

    it("does not invalidate owners when an empty atlas is cleared", () => {
      const atlas = { _pages: [{ currentRow: { x: 0, y: 0 } }], _pageLayoutVersion: 9 };
      method(source, "clearTexture").call(atlas);
      assert.equal(atlas._pageLayoutVersion, 9);
    });

    it("uploads non-mipmapped atlas textures with explicit linear filters", () => {
      const gl = {
        TEXTURE0: 100, TEXTURE_2D: 1, TEXTURE_WRAP_S: 2, TEXTURE_WRAP_T: 3,
        CLAMP_TO_EDGE: 4, RGBA: 5, UNSIGNED_BYTE: 6, TEXTURE_MIN_FILTER: 7,
        TEXTURE_MAG_FILTER: 8, LINEAR: 9,
        activeTexture: spy(), bindTexture: spy(), texParameteri: spy(),
        texImage2D: spy(), generateMipmap: spy(),
      };
      const renderer = { _atlasTextures: [{ texture: "texture", version: -1 }] };
      const atlas = { pages: [{ canvas: "glyph-canvas", version: 12 }] };
      method(source, "_bindAtlasPageTexture").call(renderer, gl, atlas, 0);
      assert.deepEqual(gl.texImage2D.calls, [[1, 0, 5, 5, 6, "glyph-canvas"]]);
      assert(gl.texParameteri.calls.some(args => args.join() === "1,7,9"));
      assert(gl.texParameteri.calls.some(args => args.join() === "1,8,9"));
      assert.equal(gl.generateMipmap.calls.length, 0);
      assert.equal(renderer._atlasTextures[0].version, 12);
    });
  });
}
