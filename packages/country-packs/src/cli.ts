import { listPackCodes, readPackFile, validatePackData } from "./loader.js";

const codes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = codes.length > 0 ? codes : listPackCodes();
let failed = 0;
for (const code of targets) {
  let problems: string[];
  try {
    problems = validatePackData(readPackFile(code));
  } catch (e) {
    problems = [(e as Error).message];
  }
  if (problems.length === 0) {
    console.log(`✔ pack ${code} valide`);
  } else {
    failed += 1;
    console.log(`✘ pack ${code} :`);
    for (const p of problems) console.log(`   - ${p}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
