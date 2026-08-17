import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const skillDir = path.resolve(process.argv[2] ?? "skills/design-personal-agent-team");
const skillFile = path.join(skillDir, "SKILL.md");
const interfaceFile = path.join(skillDir, "agents", "openai.yaml");

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter and a non-empty body");

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { fields, body: match[2].trim() };
}

async function requireFile(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Expected a file: ${file}`);
}

await requireFile(skillFile);
await requireFile(interfaceFile);

const markdown = await readFile(skillFile, "utf8");
const { fields, body } = parseFrontmatter(markdown);
const allowedFields = new Set(["name", "description"]);
for (const field of fields.keys()) {
  if (!allowedFields.has(field)) throw new Error(`Unsupported frontmatter field: ${field}`);
}

const name = fields.get("name");
const description = fields.get("description");
if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
  throw new Error("Skill name must be lowercase hyphen-case and at most 64 characters");
}
if (path.basename(skillDir) !== name) throw new Error("Skill folder must match the frontmatter name");
if (!description || description.length > 1024) throw new Error("Skill description must be 1-1024 characters");
if (!body) throw new Error("Skill body must not be empty");

const interfaceYaml = await readFile(interfaceFile, "utf8");
for (const key of ["display_name:", "short_description:", "default_prompt:"]) {
  if (!interfaceYaml.includes(key)) throw new Error(`agents/openai.yaml is missing ${key}`);
}
if (!interfaceYaml.includes(`$${name}`)) {
  throw new Error("agents/openai.yaml default_prompt must mention the skill by name");
}

console.log(`Skill valid: ${name}`);
