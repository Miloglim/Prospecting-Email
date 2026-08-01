import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { okResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";

export function seedTestData(): Result<{ contacts: number; companies: number }> {
  Log.info("seed", "开始插入测试数据");
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db.select().from(contacts).all();
  if (existing.length > 0) {
    Log.info("seed", `已有 ${existing.length} 个联系人，跳过`);
    return okResult({ contacts: existing.length, companies: 0 });
  }

  const companyData = [
    { name: "Maersk Line", domain: "maersk.com", industry: "Shipping", country: "EN" },
    { name: "DHL Global Forwarding", domain: "dhl.com", industry: "Logistics", country: "EN" },
    { name: "Kuehne + Nagel", domain: "kuehne-nagel.com", industry: "Logistics", country: "EN" },
    { name: "DB Schenker", domain: "dbschenker.com", industry: "Logistics", country: "ES" },
    { name: "DSV Panalpina", domain: "dsv.com", industry: "Logistics", country: "PT" },
    { name: "Expeditors International", domain: "expeditors.com", industry: "Freight", country: "EN" },
    { name: "C.H. Robinson", domain: "chrobinson.com", industry: "Freight", country: "ES" },
    { name: "Agility Logistics", domain: "agility.com", industry: "Logistics", country: "EN" },
    { name: "Hellmann Worldwide", domain: "hellmann.com", industry: "Logistics", country: "PT" },
    { name: "Bolloré Logistics", domain: "bollore-logistics.com", industry: "Freight", country: "ES" },
  ];

  for (const c of companyData) {
    try { db.insert(companies).values({ ...c, createdAt: now, updatedAt: now }).run(); } catch { /* */ }
  }
  const allCompanies = db.select().from(companies).all();

  const contactData = [
    { firstName: "Carlos", lastName: "Mendoza", title: "Procurement Manager", phone: "+34 612 345 678" },
    { firstName: "Ana", lastName: "Silva", title: "Supply Chain Director", phone: "+351 912 345 678" },
    { firstName: "James", lastName: "Wilson", title: "Logistics Coordinator", phone: "+1 415 555 0101" },
    { firstName: "Maria", lastName: "Garcia", title: "Import Manager", phone: "+34 623 456 789" },
    { firstName: "Robert", lastName: "Chen", title: "CEO", phone: "+1 213 555 0202" },
    { firstName: "Sofia", lastName: "Martinez", title: "Operations Manager", phone: "+34 634 567 890" },
    { firstName: "Thomas", lastName: "Mueller", title: "Head of Freight", phone: "+49 151 2345 6789" },
    { firstName: "Laura", lastName: "Fernandez", title: "Sales Director", phone: "+54 911 2345 6789" },
    { firstName: "David", lastName: "Kim", title: "VP Supply Chain", phone: "+1 310 555 0303" },
    { firstName: "Isabella", lastName: "Rossi", title: "Logistics Director", phone: "+39 333 444 5555" },
    { firstName: "Miguel", lastName: "Santos", title: "Shipping Coordinator", phone: "+55 11 91234 5678" },
    { firstName: "Emma", lastName: "Johansson", title: "Procurement Director", phone: "+46 70 123 4567" },
    { firstName: "Pedro", lastName: "Alvarez", title: "Operations Head", phone: "+52 55 1234 5678" },
    { firstName: "Sarah", lastName: "Thompson", title: "Trade Manager", phone: "+44 7700 123456" },
    { firstName: "Luis", lastName: "Gonzalez", title: "Regional Director", phone: "+56 9 1234 5678" },
    { firstName: "Yuki", lastName: "Tanaka", title: "Import/Export Manager", phone: "+81 90 1234 5678" },
    { firstName: "Diego", lastName: "Ramirez", title: "Freight Forwarder", phone: "+57 300 123 4567" },
    { firstName: "Nina", lastName: "Petrova", title: "Logistics Analyst", phone: "+7 912 345 6789" },
    { firstName: "Ahmed", lastName: "Hassan", title: "Supply Chain Manager", phone: "+971 55 123 4567" },
    { firstName: "Elena", lastName: "Dimitriou", title: "Shipping Manager", phone: "+30 691 234 5678" },
    { firstName: "Marco", lastName: "Bianchi", title: "Trade Compliance", phone: "+39 340 123 4567" },
    { firstName: "Sophie", lastName: "Dubois", title: "Air Freight Manager", phone: "+33 6 12 34 56 78" },
    { firstName: "Joao", lastName: "Oliveira", title: "Ocean Freight Specialist", phone: "+55 21 98765 4321" },
    { firstName: "Wei", lastName: "Zhang", title: "Sourcing Manager", phone: "+86 138 0000 1234" },
    { firstName: "Patricia", lastName: "Moreno", title: "Customs Broker", phone: "+34 645 678 901" },
    { firstName: "Alex", lastName: "Johnson", title: "Terminal Manager", phone: "+1 562 555 0404" },
    { firstName: "Fatima", lastName: "Al-Rashid", title: "Logistics VP", phone: "+971 50 987 6543" },
    { firstName: "Henrik", lastName: "Andersen", title: "Container Logistics", phone: "+45 20 12 34 56" },
    { firstName: "Camila", lastName: "Rojas", title: "Trade Lane Manager", phone: "+57 310 234 5678" },
    { firstName: "Oscar", lastName: "Nguyen", title: "Operations Director", phone: "+61 400 123 456" },
    { firstName: "Gabriela", lastName: "Lopez", title: "Account Executive", phone: "+1 305 555 0505" },
    { firstName: "Martin", lastName: "Fischer", title: "Branch Manager", phone: "+49 40 12345 6789" },
    { firstName: "Rosa", lastName: "Hernandez", title: "Customer Service Manager", phone: "+34 656 789 012" },
    { firstName: "Kenji", lastName: "Sato", title: "Cargo Manager", phone: "+81 3 1234 5678" },
    { firstName: "Valentina", lastName: "Costa", title: "Route Development", phone: "+351 923 456 789" },
    { firstName: "Ryan", lastName: "Miller", title: "FCL Manager", phone: "+1 843 555 0606" },
    { firstName: "Ines", lastName: "Pereira", title: "LCL Coordinator", phone: "+55 31 99876 5432" },
    { firstName: "Oliver", lastName: "Schmidt", title: "Key Account Manager", phone: "+49 211 98765 4321" },
    { firstName: "Beatriz", lastName: "Vargas", title: "Rates Manager", phone: "+52 81 2345 6789" },
    { firstName: "Daniel", lastName: "Park", title: "Warehouse Manager", phone: "+1 909 555 0707" },
  ];

  const pipeKeys = ["reaching", "quoting", "trial", "cooperating"];
  const statuses = ["", "", "reached", "reached", "replied", "replied", "replied", "bounced"];

  for (let i = 0; i < contactData.length; i++) {
    const row = contactData[i]!;
    const companyIdx = i % allCompanies.length;
    const company = allCompanies[companyIdx]!;
    const email = `${row.firstName!.toLowerCase()}.${row.lastName!.toLowerCase()}@${company.domain}`;
    const status = statuses[i % statuses.length]!;

    try {
      const extra: Record<string, unknown> = {};
      if (status === "replied" || status === "reached") {
        extra.crmReminder = { nextFollowupAt: new Date(Date.now() + i * 3600000).toISOString() };
      }

      db.insert(contacts).values({
        email,
        firstName: row.firstName, lastName: row.lastName,
        title: row.title, phone: row.phone || null,
        companyId: company.id,
        country: ["EN", "ES", "PT"][i % 3],
        clientType: i % 3 === 0 ? "agent" : "direct",
        status,
        tags: status ? JSON.stringify([pipeKeys[i % pipeKeys.length]]) : "[]",
        extra: JSON.stringify(extra),
        isBounced: status === "bounced" ? 1 : 0,
        source: i % 5 === 0 ? "import" : "manual",
        createdAt: now, updatedAt: now,
      }).run();
    } catch (err: unknown) {
      Log.warn("seed", `${email} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const allContacts = db.select().from(contacts).all();
  saveDatabase();
  Log.info("seed", `插入 ${allContacts.length} 联系人, ${allCompanies.length} 公司`);
  return okResult({ contacts: allContacts.length, companies: allCompanies.length });
}
