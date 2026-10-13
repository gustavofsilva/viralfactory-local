import { diagnose } from '../apps/api/src/doctor.js';
import { db } from '../apps/api/src/db.js';
try {
  const checks = await diagnose(true);
  console.table(checks.map(check => ({ Componente: check.name, Estado: check.status, Detalhe: check.detail })));
} finally { await db.$disconnect(); }
