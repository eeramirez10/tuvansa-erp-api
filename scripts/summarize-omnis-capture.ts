import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

interface CaptureEvent {
  timestamp: string;
  type: 'ready' | 'connection' | 'marker' | 'query' | 'prepare';
  label?: string;
  connectionId?: number;
  sql?: string;
}

interface CapturedStatement {
  timestamp: string;
  type: 'query' | 'prepare';
  connectionId?: number;
  sql: string;
}

interface CaptureSection {
  label: string;
  statements: CapturedStatement[];
}

const inputPath = resolve(process.argv[2] ?? 'captures/accounts-receivable-2026-08-25.log');
const outputPath = resolve(
  process.argv[3] ?? 'docs/modules/accounts-receivable/legacy-mysql-capture.md',
);

const events = readFileSync(inputPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line) as CaptureEvent;
    } catch {
      throw new Error(`La linea ${index + 1} de ${inputPath} no contiene JSON valido`);
    }
  });

const sections: CaptureSection[] = [];
let currentSection: CaptureSection = { label: 'ANTES_DEL_PRIMER_MARCADOR', statements: [] };
sections.push(currentSection);

for (const event of events) {
  if (event.type === 'marker') {
    currentSection = {
      label: event.label ?? 'MARCADOR_SIN_NOMBRE',
      statements: [],
    };
    sections.push(currentSection);
    continue;
  }

  if ((event.type === 'query' || event.type === 'prepare') && event.sql !== undefined) {
    currentSection.statements.push({
      timestamp: event.timestamp,
      type: event.type,
      connectionId: event.connectionId,
      sql: event.sql,
    });
  }
}

const verbOf = (sql: string): string => sql.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? 'OTRO';
const escapeCell = (value: string): string => value.replaceAll('|', '\\|');

const statementCount = sections.reduce((total, section) => total + section.statements.length, 0);
const verbCounts = new Map<string, number>();

for (const { statements } of sections) {
  for (const statement of statements) {
    const verb = statement.type === 'prepare' ? 'PREPARE' : verbOf(statement.sql);
    verbCounts.set(verb, (verbCounts.get(verb) ?? 0) + 1);
  }
}

const lines: string[] = [
  '# Captura MySQL de OMNIS: Catalogo de clientes',
  '',
  `Fuente cruda local: \`${basename(inputPath)}\`.`,
  '',
  `Eventos SQL capturados: **${statementCount}**. Las sentencias aparecen en el orden real`,
  'en que OMNIS las envio. Los valores son literales de la base de prueba; al llevarlas a',
  'la API deben convertirse en parametros.',
  '',
  '## Totales por operacion',
  '',
  '| Operacion | Cantidad |',
  '| --- | ---: |',
  ...[...verbCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([verb, count]) => `| ${escapeCell(verb)} | ${count} |`),
  '',
  '## Totales por marcador',
  '',
  '| Marcador | SQL | SELECT | INSERT | UPDATE | DELETE | Otros |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
];

for (const section of sections.filter(({ statements }) => statements.length > 0)) {
  const counts = { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0, other: 0 };

  for (const statement of section.statements) {
    const verb = statement.type === 'prepare' ? 'PREPARE' : verbOf(statement.sql);
    if (verb === 'SELECT' || verb === 'INSERT' || verb === 'UPDATE' || verb === 'DELETE') {
      counts[verb] += 1;
    } else {
      counts.other += 1;
    }
  }

  lines.push(
    `| ${escapeCell(section.label)} | ${section.statements.length} | ${counts.SELECT} | ${counts.INSERT} | ${counts.UPDATE} | ${counts.DELETE} | ${counts.other} |`,
  );
}

lines.push('', '## Sentencias por pantalla o accion', '');

for (const section of sections.filter(({ statements }) => statements.length > 0)) {
  lines.push(`### ${section.label}`, '');

  section.statements.forEach((statement, index) => {
    const metadata = [
      statement.timestamp,
      statement.connectionId === undefined ? undefined : `conexion ${statement.connectionId}`,
      statement.type === 'prepare' ? 'PREPARE' : undefined,
    ].filter(Boolean).join(' - ');

    lines.push(`${index + 1}. ${metadata}`, '', '```sql', statement.sql, '```', '');
  });
}

writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Resumen creado en ${outputPath}`);
console.log(`${statementCount} sentencias agrupadas en ${sections.length} secciones`);
