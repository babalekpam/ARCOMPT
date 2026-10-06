import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { AnthropicProvider, OpenAIProvider, GeminiProvider, AI_PROVIDER_KEYS, resolveAiProviderSelection, type AiProviderName, type ModelProvider } from "@arcompt/ai-gateway";

export const aiProviderNames = ["anthropic","openai","gemini"] as const;
export const aiDefaultModels = { anthropic:"claude-sonnet-5",openai:"gpt-4o-mini",gemini:"gemini-2.5-flash" };
export const aiModelVariables = {anthropic:"AI_ANTHROPIC_MODEL",openai:"AI_OPENAI_MODEL",gemini:"AI_GEMINI_MODEL"} as const;
export interface StoredAiSettings {
  defaultProvider: AiProviderName;
  captureProvider: AiProviderName;
  categorizeProvider: AiProviderName;
  models: Record<AiProviderName,string>;
  keys: Partial<Record<AiProviderName,string>>;
}
function encryptionKey(env: NodeJS.ProcessEnv) {
  const input = env.AI_SETTINGS_ENCRYPTION_KEY ?? env.PAYROLL_ENCRYPTION_KEY ?? "";
  const raw = /^[0-9a-fA-F]{64}$/.test(input) ? Buffer.from(input,"hex") : Buffer.from(input,"base64");
  if (raw.length!==32) throw Error("AI settings encryption unavailable");
  return Buffer.from(hkdfSync("sha256",raw,"arcompt:ai-settings:v1","encrypted-provider-credentials",32));
}
export function aiEncryptionAvailable(env: NodeJS.ProcessEnv=process.env) {
  try { encryptionKey(env); return true; } catch { return false; }
}
export function encryptAiSettings(value: StoredAiSettings,env: NodeJS.ProcessEnv=process.env): string {
  const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",encryptionKey(env),iv);
  cipher.setAAD(Buffer.from("arcompt:ai-settings:v1"));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return ["v1",iv.toString("base64"),cipher.getAuthTag().toString("base64"),encrypted.toString("base64")].join(".");
}
export function decryptAiSettings(value:string,env:NodeJS.ProcessEnv=process.env):StoredAiSettings {
  try {
    const [version,iv,tag,body,...extra]=value.split(".");
    if(version!=="v1"||!iv||!tag||!body||extra.length)throw Error();
    const decipher=createDecipheriv("aes-256-gcm",encryptionKey(env),Buffer.from(iv,"base64"));
    decipher.setAAD(Buffer.from("arcompt:ai-settings:v1")); decipher.setAuthTag(Buffer.from(tag,"base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body,"base64")),decipher.final()]).toString("utf8")) as StoredAiSettings;
  } catch { throw Error("AI settings cannot be decrypted"); }
}
export async function readAiSettings(db:Sql,env:NodeJS.ProcessEnv=process.env) {
  const [row]=await db`SELECT * FROM platform_ai_runtime()`;
  if(!row)throw Error("AI settings unavailable");
  return {revision:Number(row.revision),stored:row.payload_cipher ? decryptAiSettings(String(row.payload_cipher),env):null};
}
export function mergeAiSettings(env:NodeJS.ProcessEnv,stored:StoredAiSettings|null):NodeJS.ProcessEnv {
  if(!stored)return {...env};
  const result:NodeJS.ProcessEnv={...env,AI_PROVIDER:stored.defaultProvider,AI_CAPTURE_PROVIDER:stored.captureProvider,AI_CATEGORIZE_PROVIDER:stored.categorizeProvider};
  for(const p of aiProviderNames) {
    result[aiModelVariables[p]]=stored.models[p];
    if(stored.keys[p])result[AI_PROVIDER_KEYS[p]]=stored.keys[p];
  }
  return result;
}
export async function runtimeAiEnv(db:Sql,env:NodeJS.ProcessEnv=process.env) {
  return mergeAiSettings(env,(await readAiSettings(db,env)).stored);
}
export function initialAiSettings(env:NodeJS.ProcessEnv):StoredAiSettings {
  const s=resolveAiProviderSelection(env);
  return {defaultProvider:s.defaultProvider,captureProvider:s.routes.capture,categorizeProvider:s.routes.categorize,
    models:Object.fromEntries(aiProviderNames.map(p=>[p,env[aiModelVariables[p]]||(p==="anthropic"?env.AI_MODEL:undefined)||aiDefaultModels[p]])) as Record<AiProviderName,string>,keys:{}};
}
export function configuredAiProvider(provider:AiProviderName,env:NodeJS.ProcessEnv):ModelProvider {
  const apiKey=env[AI_PROVIDER_KEYS[provider]]??"", model=env[aiModelVariables[provider]]||(provider==="anthropic"?env.AI_MODEL:undefined)||aiDefaultModels[provider];
  if(!apiKey.trim())throw Error("AI provider key missing");
  if(provider==="anthropic")return new AnthropicProvider({apiKey,model,timeoutMs:15000});
  if(provider==="openai")return new OpenAIProvider({apiKey,model,timeoutMs:15000});
  return new GeminiProvider({apiKey,model,timeoutMs:15000});
}
export { AI_PROVIDER_KEYS };
