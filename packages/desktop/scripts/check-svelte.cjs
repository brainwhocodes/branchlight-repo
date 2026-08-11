const path = require("node:path");
const Module = require("node:module");

const packageNodeModules = path.resolve(__dirname, "../node_modules");
const checkerBin = path.resolve(__dirname, "../../../node_modules/@branchlight/svelte-check/bin/svelte-check");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveBranchlight(request, parent, isMain, options) {
  if (request === "typescript" || request === "typescript/package.json") {
    return resolveFilename.call(this, request, { paths: [packageNodeModules] }, isMain, options);
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

require(checkerBin);
