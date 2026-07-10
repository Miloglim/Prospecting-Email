const db = require('../electron/modules/services/db').getDb();
console.log('1. DB OK');

const contacts = require('../electron/modules/services/contacts-db');
const all = contacts.listAll();
console.log('2. Contacts:', all.length, all.length >= 5000 ? 'OK' : 'FAIL');

const test = all[0];
const orig = test.stage || 'cold';
const next = {cold:'f1',f1:'f2',f2:'f3',f3:'f4',f4:'f4'}[orig];
contacts.setStage(test.id, next, 'smoke-test');
const after = contacts.getById(test.id);
console.log('3. Stage:', orig, '->', after.stage, after.stage === next ? 'OK' : 'FAIL');
contacts.update(test.id, {stage: orig});

contacts.addTag(test.id, 'reached');
console.log('4. Tag:', contacts.getById(test.id).tags.includes('reached') ? 'OK' : 'FAIL');
contacts.removeTag(test.id, 'reached');

const dash = require('../electron/modules/services/dashboard-service');
const stats = dash.getStats({sendQueue:[]});
console.log('5. Dashboard:', typeof stats.sentToday === 'number' ? 'OK' : 'FAIL');

const svc = require('../electron/modules/services/contacts-service');
console.log('6. SplitName:', svc.splitName('Carlos Ruiz').firstName === 'Carlos' ? 'OK' : 'FAIL');
console.log('7. NormalizeCountry:', svc.normalizeCountry('巴西') === 'Brazil' ? 'OK' : 'FAIL');

const IPC = require('../electron/modules/core/contract').IPC;
console.log('8. Contract COMPANY:', !!IPC.COMPANY ? 'OK' : 'FAIL');
console.log('9. Contract AUTO_SEND:', !!IPC.AUTO_SEND ? 'OK' : 'FAIL');

console.log('\nALL DONE');
process.exit(0);
