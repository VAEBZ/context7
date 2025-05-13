import fs from "fs";
import path from "path";

export interface Context7Config {
  defaultLang: string;
  defaultVersion: string;
  supportedLangs: string[];
  supportedVersions: Record<string, string[]>;
}

const DEFAULT_CONFIG: Context7Config = {
  defaultLang: "python",
  defaultVersion: "3.11",
  supportedLangs: ["python"],
  supportedVersions: { python: ["3.11"] },
};

export function getContext7Config(): Context7Config {
  const configPath = path.resolve(process.cwd(), ".context7rc.json");
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (e) {
      console.warn("Failed to parse .context7rc.json, using defaults", e);
    }
  }
  return DEFAULT_CONFIG;
} 