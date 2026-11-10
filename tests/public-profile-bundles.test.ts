import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

test("public profile and standalone entries exclude screener providers; HookChart is outside the initial profile graph", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/community/publicProfile.tsx", "src/community/standalone.tsx"],
    bundle: true, splitting: true, format: "esm", platform: "browser", packages: "external",
    outdir: ".profile-bundle-fixture", write: false, metafile: true,
    plugins: [{ name: "ignore-styles", setup(b) { b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" })); } }],
  });
  const outputs = result.metafile!.outputs;
  const entry = Object.entries(outputs).find(([, output]) => output.entryPoint === "src/community/publicProfile.tsx")!;
  const closure = new Set<string>();
  function visit(file: string) {
    if (closure.has(file)) return;
    closure.add(file);
    for (const dependency of outputs[file]?.imports ?? [])
      if (!dependency.external && dependency.kind !== "dynamic-import") visit(dependency.path);
  }
  visit(entry[0]);
  const initialInputs = [...closure].flatMap(file => Object.keys(outputs[file].inputs));
  assert.ok(initialInputs.some(file => file.endsWith("ChartPreview.tsx")));
  assert.ok(!initialInputs.some(file => /SharedHookChart|hookchart\/engine\.tsx/.test(file)), initialInputs.join("\n"));
  const allInputs = Object.keys(result.metafile!.inputs);
  assert.ok(!allInputs.some(file => /(^|\/)(App\.tsx|AlertsContext\.tsx|SurveillanceContext\.tsx|directExchangeClient\.ts|HookChartCanvas\.tsx)$/.test(file)), allInputs.join("\n"));
  assert.ok(Object.values(outputs).some(output => output.entryPoint?.endsWith("SharedHookChart.tsx")));
});
