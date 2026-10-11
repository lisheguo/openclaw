import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * 每次注入前从真实文件读取（HOOK-02：保证 SKILL.md 更新即时生效），
 * 插件内不保留第二份规则副本；glpi-ticket/SKILL.md 仍是唯一业务模板标准。
 */
export function createSkillReader(skillPath) {
  return function readSkill() {
    try {
      const text = readFileSync(skillPath, "utf8");
      const sha256 = createHash("sha256").update(text).digest("hex");
      return { ok: true, text, sha256 };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  };
}