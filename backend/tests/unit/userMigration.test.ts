import {describe,it,expect,vi} from 'vitest';
import {planBindings,verifyIdentities} from '../../scripts/user-binding-migration.mjs';
const user={_id:'user1',email:'user@example.test',isAdmin:true,isAuthorized:true};
const manifest={version:1,projectId:'dev-project',reviewedBy:'reviewer',bindings:[{userId:'user1',uid:'firebase-user',isAdmin:false,isAuthorized:true}]};
describe('reviewed UID migration',()=>{
 it('does not inherit the old auto-admin flag and performs no mutation during planning',()=>{const plan=planBindings([user],manifest);expect(plan.operations[0].after.isAdmin).toBe(false);expect(user.isAdmin).toBe(true);expect(plan.sha256).toHaveLength(64)});
 it('does not infer bindings from matching email',()=>{const plan=planBindings([user],{...manifest,bindings:[]});expect(plan.operations).toEqual([]);expect(plan.unboundAfter).toBe(1)});
 it.each([{uid:''},{isAdmin:'true'},{isAuthorized:false,isAdmin:true},{userId:'missing'}])('rejects incomplete/unreviewable binding %j',patch=>{expect(()=>planBindings([user],{...manifest,bindings:[{...manifest.bindings[0],...patch}]})).toThrow()});
 it('rejects duplicate reviewed bindings',()=>expect(()=>planBindings([user],{...manifest,bindings:[manifest.bindings[0],manifest.bindings[0]]})).toThrow('DUPLICATE'));
 it('rejects preexisting duplicate identities even outside the proposed records',()=>expect(()=>planBindings([{...user,firebaseUid:'x',firebaseProjectId:'p'},{...user,_id:'user2',firebaseUid:'x',firebaseProjectId:'p'}],{...manifest,bindings:[]})).toThrow('DUPLICATE'));
 it('requires separate review for rebinding',()=>expect(()=>planBindings([{...user,firebaseUid:'old',firebaseProjectId:'dev-project'}],manifest)).toThrow('REBIND'));
 it('changes the plan hash if the source grant changes',()=>expect(planBindings([user],manifest).sha256).not.toBe(planBindings([{...user,isAdmin:false}],manifest).sha256));
 it.each([{disabled:true},{emailVerified:false},{email:'someone-else@example.test'},{uid:'other'}])('rejects Firebase identity mismatch %j',async patch=>{const plan=planBindings([user],manifest);await expect(verifyIdentities(plan,async()=>({uid:'firebase-user',email:user.email,emailVerified:true,disabled:false,...patch}))).rejects.toThrow('MISMATCH')});
 it('verifies all reviewed identities against the trusted project provider',async()=>{const get=vi.fn(async()=>({uid:'firebase-user',email:user.email,emailVerified:true,disabled:false}));await verifyIdentities(planBindings([user],manifest),get);expect(get).toHaveBeenCalledWith('firebase-user')});
});
