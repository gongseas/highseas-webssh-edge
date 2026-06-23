import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";

const nodeBuiltins = [
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs",
  "http", "https", "net", "os", "path", "process", "stream", "tls",
  "url", "util", "zlib"
];

const workerCompatibility = {
  name: "worker-compatibility",
  setup(build) {
    build.onResolve(
      { filter: new RegExp(`^(${nodeBuiltins.join("|")})$`) },
      (args) => ({ path: args.path, namespace: "node-builtin-wrapper" })
    );
    build.onLoad({ filter: /.*/, namespace: "node-builtin-wrapper" }, (args) => ({
      contents: `import * as nodeModule from "node:${args.path}"; module.exports = nodeModule.default ?? nodeModule;`,
      loader: "js"
    }));
    build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
    build.onLoad({ filter: /[\\/]asn1[\\/]lib[\\/]ber[\\/]writer\.js$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")).replace(
        "(!strings instanceof Array)",
        "(!(strings instanceof Array))"
      ),
      loader: "js"
    }));
    build.onResolve({ filter: /\.node$/ }, () => ({ path: "native-addon", namespace: "native-addon-stub" }));
    build.onLoad({ filter: /.*/, namespace: "native-addon-stub" }, () => ({ contents: "throw new Error('Native addon unavailable in Workers');", loader: "js" }));
  }
};

await esbuild.build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  outfile: "dist/worker/index.mjs",
  format: "esm",
  target: "es2022",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import", "require"],
  external: ["cloudflare:*"],
  plugins: [workerCompatibility],
  logLevel: "info"
});
