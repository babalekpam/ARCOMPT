import { beforeAll,afterAll,afterEach,describe,it,expect,vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { createTestDatabase } from "@arcompt/db/testing";
import { platformAiRoutes } from "./routes/platform-ai.js";
import { modeEvidence } from "./admin-mode.js";
import { decryptAiSettings,encryptAiSettings,initialAiSettings,runtimeAiEnv,enableStoredAiSettings,createDocumentsInfraFromEnv,resetDocumentsInfra,PgCallLogger } from "@arcompt/documents";
const db=await createTestDatabase();
const suite=db?describe:describe.skip;
const env={AI_PROVIDER:"anthropic",ANTHROPIC_API_KEY:"environment-test-secret",PAYROLL_ENCRYPTION_KEY:"ab".repeat(32)};
const evidence=modeEvidence("session","mode-token","proof");
function app(admin=true,valid=true) {
  const h=new Hono();
  h.use("*",async(c,next)=>{
    c.set("auth",{userId:"admin",tenantId:"",roles:[],platformAdmin:admin,platformSub:"subject",
      platformMode:{...evidence,sid:valid?"session":"wrong"}});
    await next();
  });
  h.route("/platform/ai",platformAiRoutes(db!.appDb,env));
  return h;
}
const body=(revision:number)=>({revision,defaultProvider:"openai",captureProvider:"anthropic",categorizeProvider:"openai",
  models:{anthropic:"claude-sonnet-5",openai:"gpt-4o-mini",gemini:"gemini-2.5-flash"},keys:{openai:"saved-test-secret"}});
beforeAll(async()=>{
  if(!db)return;
  await db.db.unsafe(`INSERT INTO organization(id,name) VALUES('11111111-1111-4111-8111-111111111111','Internal');
  INSERT INTO platform_admin_reserved_org(organization_id) VALUES('11111111-1111-4111-8111-111111111111');
  INSERT INTO app_user(id,organization_id,email,display_name) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','admin@example.test','Admin');
  INSERT INTO platform_admin(user_id) VALUES('22222222-2222-4222-8222-222222222222');
  INSERT INTO platform_admin_binding VALUES('subject','22222222-2222-4222-8222-222222222222');
  INSERT INTO app_mfa_factor(clerk_sub,enabled_at) VALUES('subject',now());`);
  await db.db`INSERT INTO app_mfa_proof VALUES(${evidence.proofHash},'subject','session',now()+interval '15 minutes')`;
  await db.appDb`SELECT platform_mode_activate('subject','session',${evidence.proofHash},${evidence.tokenHash})`;
});
afterAll(async()=>{await db?.drop();});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();resetDocumentsInfra();});
suite("AI admin configuration end to end",()=>{
  it("denies ordinary and expired administrators for every route",async()=>{
    for(const h of [app(false),app(true,false)])for(const [method,path] of [["GET",""],["PUT",""],["DELETE","?revision=0"],["POST","/providers/openai/test"]] as const) {
      expect((await h.request("/platform/ai"+path,{method})).status).toBe(403);
    }
  });
  it("reads metadata without returning inherited credentials",async()=>{
    const r=await app().request("/platform/ai"),text=await r.text();
    expect(r.status).toBe(200);expect(text).not.toContain("environment-test-secret");
    expect(JSON.parse(text).providers[0]).toMatchObject({configured:true,source:"environment"});
  });
  it("saves encrypted keys, masks them, activates runtime config, and rejects stale writes",async()=>{
    const h=app(),r=await h.request("/platform/ai",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body(0))});
    expect(r.status).toBe(200);expect(await r.text()).not.toContain("saved-test-secret");
    const [row]=await db!.db`SELECT * FROM platform_ai_settings`;
    expect(row!.payload_cipher).not.toContain("saved-test-secret");
    expect(decryptAiSettings(row!.payload_cipher,env).keys.openai).toBe("saved-test-secret");
    expect(await runtimeAiEnv(db!.appDb,env)).toMatchObject({AI_PROVIDER:"openai",OPENAI_API_KEY:"saved-test-secret",AI_CAPTURE_PROVIDER:"anthropic"});
    expect((await h.request("/platform/ai",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body(0))})).status).toBe(409);
    await expect(db!.appDb`UPDATE platform_ai_settings SET payload_cipher=NULL`).rejects.toMatchObject({code:"42501"});
    await expect(db!.appDb`SELECT platform_ai_save('ordinary',NULL,NULL,NULL,1,NULL)`).rejects.toBeDefined();
  });
  it("uses stored credentials in existing accounting gateway without restart or fallback",async()=>{
    const fetch=vi.fn(async (_url: string|URL|Request,_options?:RequestInit)=>new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}],model:"gpt-4o-mini",usage:{prompt_tokens:1,completion_tokens:1}}),{status:200}));
    vi.stubGlobal("fetch",fetch); vi.spyOn(PgCallLogger.prototype,"append").mockResolvedValue();
    enableStoredAiSettings();
    const gateway=createDocumentsInfraFromEnv(db!.appDb,env).gateway;
    await gateway.callJson({tenantId:"test"},{capability:"assistant",promptVersion:"test",system:"Test",input:{}},z.object({ok:z.boolean()}));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({authorization:"Bearer saved-test-secret"});
    fetch.mockImplementation(async()=>new Response("secret error",{status:401}));
    await expect(gateway.callJson({tenantId:"test"},{capability:"assistant",promptVersion:"test",system:"Test",input:{}},z.object({ok:z.boolean()}))).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("tests a fixed provider endpoint and redacts provider errors",async()=>{
    const fetch=vi.fn(async(_url:string|URL|Request)=>new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}],model:"gpt-4o-mini",usage:{prompt_tokens:1,completion_tokens:1}}),{status:200}));
    vi.stubGlobal("fetch",fetch);
    const r=await app().request("/platform/ai/providers/openai/test",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    expect(await r.json()).toMatchObject({ok:true});
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    vi.stubGlobal("fetch",async()=>new Response("saved-test-secret",{status:401}));
    const failed=await app().request("/platform/ai/providers/openai/test",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    expect(await failed.text()).not.toContain("saved-test-secret");
  });
  it("refuses deleting selected key and safely resets to environment",async()=>{
    expect((await app().request("/platform/ai/providers/openai?revision=1",{method:"DELETE"})).status).toBe(400);
    const r=await app().request("/platform/ai?revision=1",{method:"DELETE"});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({defaultProvider:"anthropic"});
  });
  it("rejects arbitrary endpoints and unknown providers",async()=>{
    const b={...body(2),baseUrl:"http://localhost"};
    expect((await app().request("/platform/ai",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(b)})).status).toBe(400);
    expect((await app().request("/platform/ai/providers/unknown/test",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(400);
  });
});
describe("AI encryption isolation",()=>{
  it("authenticates ciphertext and fails closed on wrong key or corruption",()=>{
    const encrypted=encryptAiSettings(initialAiSettings(env),env);
    expect(decryptAiSettings(encrypted,env)).toEqual(initialAiSettings(env));
    expect(()=>decryptAiSettings(encrypted,{PAYROLL_ENCRYPTION_KEY:"cd".repeat(32)})).toThrow();
    expect(()=>decryptAiSettings(encrypted.slice(0,-7),env)).toThrow();
  });
});
