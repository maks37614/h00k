import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyH00kToken, requireUserAuth } from '../server/userAuth';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const previous=process.env.H00K_AUTH_PUBLIC_KEY;process.env.H00K_AUTH_PUBLIC_KEY=publicKey.export({type:'spki',format:'pem'}).toString();
test.after(()=>{if(previous)process.env.H00K_AUTH_PUBLIC_KEY=previous;else delete process.env.H00K_AUTH_PUBLIC_KEY;});
function token(sub='alice',patch:any={},head:any={}){const now=Date.now()/1000,h=Buffer.from(JSON.stringify({alg:'RS256',...head})).toString('base64url'),b=Buffer.from(JSON.stringify({sub,aud:'h00k.top',iss:'h00k',iat:now-10,auth_time:now-10,exp:now+300,...patch})).toString('base64url');return h+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+b),privateKey).toString('base64url');}
test('native h00k signatures identify owners without external identity requests',async()=>{assert.equal(await verifyH00kToken(token()),'alice');assert.equal(await verifyH00kToken(token('bob')),'bob');});
test('legacy Firebase, expired, forged, wrong audience and confused algorithms fail closed',async()=>{for(const value of [token('guest'),token('alice',{exp:1}),token('alice',{iss:'https://securetoken.google.com/project'}),token('alice',{aud:'another-app'}),token('alice',{iat:Date.now()/1000+1000}),token('alice',{}, {alg:'none'}),'invalid'])await assert.rejects(verifyH00kToken(value));const valid=token();await assert.rejects(verifyH00kToken(valid.slice(0,valid.lastIndexOf('.')+1)+Buffer.alloc(256,1).toString('base64url')));});
test('caller cannot select another owner',async()=>{for(const other of [false,true]){const req:any={get:(name:string)=>name==='Authorization'?'Bearer '+token():undefined,query:other?{userId:'bob'}:{},body:{}};let status=200,accepted=false;const res:any={locals:{},status(n:number){status=n;return this;},json(){}};await requireUserAuth(req,res,()=>{accepted=true;});assert.equal(accepted,!other);assert.equal(status,other?403:200);if(!other)assert.equal(res.locals.userId,'alice');}});
