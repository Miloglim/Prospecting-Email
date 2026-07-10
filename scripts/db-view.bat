@echo off
cd /d "%~dp0\.."
node -e "const db=new (require('better-sqlite3'))('data/prospector.db');var t=db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all();console.log('Tables:',t.map(function(r){return r.name}));var c=db.prepare('SELECT COUNT(*) as n FROM contacts').get();var co=db.prepare('SELECT COUNT(*) as n FROM companies').get();console.log('Contacts:',c.n,'Companies:',co.n)"
pause
