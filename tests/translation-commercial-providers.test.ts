import {afterEach,expect,it,vi} from 'vitest';
import {validateOptions} from '@/lib/translation/providers';
import {optionsSchema} from '@/lib/translation/types';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('checks commercial ASR against the gateway-selected model, not a stale worker environment',async()=>{
 vi.stubEnv('STUDIO_COMMERCIAL_MODE','true');vi.stubEnv('STUDIO_ASR_PROVIDER','local');vi.stubEnv('STUDIO_TRANSLATION_PROVIDER','openai');vi.stubEnv('STUDIO_TTS_PROVIDER','openai');vi.stubEnv('OPENAI_API_KEY','test');vi.stubEnv('WHISPER_MODEL','small');
 vi.stubEnv('STUDIO_LICENSE_APPROVALS_JSON',JSON.stringify({asr:{model:'small',license:'MIT',evidence:'https://example.com/review',reviewedAt:'2026-10-15',commercial:true}}));
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ready:true,languages:['en'],voices:['en'],asrModels:[{id:'configured',label:'large-v3',selected:true}],diarization:false,cloning:false,separation:false,message:'ready'})));
 await expect(validateOptions(optionsSchema.parse({targets:['en'],mode:'subtitles',rights:true,cloudConsent:true}))).rejects.toThrow(/licens/);
});
it('does not require an unused local diarization license for cloud diarization',async()=>{
 vi.stubEnv('STUDIO_COMMERCIAL_MODE','true');vi.stubEnv('STUDIO_ASR_PROVIDER','openai');vi.stubEnv('STUDIO_TRANSLATION_PROVIDER','openai');vi.stubEnv('STUDIO_TTS_PROVIDER','openai');vi.stubEnv('OPENAI_API_KEY','test');vi.stubEnv('STUDIO_LICENSE_APPROVALS_JSON','{}');
 await expect(validateOptions(optionsSchema.parse({targets:['en'],mode:'subtitles',diarize:true,rights:true,cloudConsent:true}))).resolves.toMatchObject({diarization:true});
});
