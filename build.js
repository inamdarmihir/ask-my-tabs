import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const entryPoints = [
  { in: "src/background.js", out: "background" },
  { in: "src/offscreen.js", out: "offscreen" },
  { in: "src/popup.js", out: "popup" },
  { in: "src/settings.js", out: "settings" },
  { in: "src/onboarding.js", out: "onboarding" },
];

const options = {
  entryPoints: entryPoints.map((e) => e.in),
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  conditions: ["browser"],
  outdir: "dist",
  entryNames: "[name].bundle",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
}
