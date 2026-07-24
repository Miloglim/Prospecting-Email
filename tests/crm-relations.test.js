"use strict";
const assert = require("assert");
const contactsDb = require("../electron/modules/services/contacts-db");
const { getDb } = require("../electron/modules/services/db");
const crm = require("../electron/modules/services/crm-service");

function setup() {
  const db = getDb();
  db.exec("DELETE FROM contacts");
  const c1 = contactsDb.upsert({ email: "a@test.com", company: "TestCo", firstName: "Alice" });
  const c2 = contactsDb.upsert({ email: "b@test.com", company: "TestCo", firstName: "Bob" });
  const c3 = contactsDb.upsert({ email: "c@test.com", company: "TestCo", firstName: "Charlie" });
  return { c1, c2, c3 };
}

// Test 1: gets same-company contacts
{
  const { c1 } = setup();
  const r = crm.getRelations(c1.id);
  assert.ok(r.ok, "should return ok");
  assert.ok(Array.isArray(r.data.nodes), "nodes should be array");
  assert.ok(Array.isArray(r.data.edges), "edges should be array");
  assert.ok(r.data.nodes.length >= 2, "at least 2 company contacts");
  assert.ok(r.data.nodes.every(n => n.id && n.name), "each node has id and name");
  console.log("PASS: basic getRelations");
}

// Test 2: no company → returns self only
{
  const c = contactsDb.upsert({ email: "solo@test.com", firstName: "Solo" });
  const r = crm.getRelations(c.id);
  assert.ok(r.ok);
  assert.strictEqual(r.data.nodes.length, 1);
  console.log("PASS: no company");
}

// Test 3: response trimmed — no _extra field
{
  const { c1 } = setup();
  const r = crm.getRelations(c1.id);
  for (const n of r.data.nodes) {
    assert.ok(!n._extra, "node should not have _extra");
  }
  console.log("PASS: field trimming");

  getDb().exec("DELETE FROM contacts");
}

// Test 4: saveRelation — creates a custom edge
{
  const { c1, c2 } = setup();
  const r = crm.saveRelation(c1.id, c2.id, "同事");
  assert.ok(r.ok, "save should return ok");
  assert.strictEqual(r.data.id, c1.id, "should return from contact id");

  // verify persistence via getRelations
  const rel = crm.getRelations(c1.id);
  const customEdge = rel.data.edges.find(e => e.type === "custom" || e.type === "");
  assert.ok(customEdge, "should have a custom edge after save");
  console.log("PASS: saveRelation");
}

// Test 5: saveRelation — dedup same (fromId, toId, label)
{
  const { c1, c2 } = setup();
  crm.saveRelation(c1.id, c2.id, "朋友");
  const r2 = crm.saveRelation(c1.id, c2.id, "朋友");
  assert.ok(r2.ok, "second save (dup) should still return ok");

  const rel = crm.getRelations(c1.id);
  const customEdges = rel.data.edges.filter(e => e.type === "custom" || e.type === "");
  assert.strictEqual(customEdges.length, 1, "should dedup and have only 1 edge");
  console.log("PASS: dedup saveRelation");
}

// Test 6: saveRelation — rejects self-relation
{
  const { c1 } = setup();
  const r = crm.saveRelation(c1.id, c1.id, "自己");
  assert.strictEqual(r.ok, false, "self-relation should be rejected");
  assert.ok(r.error, "should have error message");
  console.log("PASS: self-reject");
}

// Test 7: deleteRelation — removes the edge
{
  const { c1, c2 } = setup();
  crm.saveRelation(c1.id, c2.id, "同事");
  const r = crm.deleteRelation(c1.id, c2.id, "同事");
  assert.ok(r.ok, "delete should return ok");

  const rel = crm.getRelations(c1.id);
  const customEdges = rel.data.edges.filter(e => e.type === "custom" || e.type === "");
  assert.strictEqual(customEdges.length, 0, "edge should be removed after delete");
  console.log("PASS: deleteRelation");

  getDb().exec("DELETE FROM contacts");
}
