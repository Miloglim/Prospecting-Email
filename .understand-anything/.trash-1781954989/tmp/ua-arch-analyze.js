#!/usr/bin/env node
/**
 * Phase 1 — Structural Analysis Script
 * Computes directory grouping, import adjacency, cross-category dependencies,
 * inter/intra-group density, pattern matching, deployment topology, etc.
 */
const fs = require('fs');
const path = require('path');

// ─── CLI ───────────────────────────────────────────────────────────
const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  console.error('Usage: node ua-arch-analyze.js <input.json> <output.json>');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
} catch (e) {
  console.error('Failed to read or parse input JSON:', e.message);
  process.exit(1);
}

const { fileNodes, importEdges, allEdges } = data;
if (!fileNodes || !Array.isArray(fileNodes)) {
  console.error('Input JSON must contain a "fileNodes" array.');
  process.exit(1);
}

const allFileNodeIds = new Set(fileNodes.map(n => n.id));

// ─── HELPERS ────────────────────────────────────────────────────────
/** Get the top-level directory after removing common path prefix */
function getDirGroup(filePath) {
  // Normalize slashes
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return 'root';
  // Group by first directory segment
  return parts[0];
}

/** Pattern matching for directory names */
function matchDirectoryPattern(dirName) {
  const patterns = {
    'routes': 'api', 'api': 'api', 'controllers': 'api', 'endpoints': 'api', 'handlers': 'api',
    'services': 'service', 'core': 'service', 'lib': 'service', 'domain': 'service', 'logic': 'service',
    'models': 'data', 'db': 'data', 'data': 'data', 'persistence': 'data', 'repository': 'data', 'entities': 'data',
    'components': 'ui', 'views': 'ui', 'pages': 'ui', 'ui': 'ui', 'layouts': 'ui', 'screens': 'ui',
    'middleware': 'middleware', 'plugins': 'middleware', 'interceptors': 'middleware', 'guards': 'middleware',
    'utils': 'utility', 'helpers': 'utility', 'common': 'utility', 'shared': 'utility', 'tools': 'utility',
    'config': 'config', 'constants': 'config', 'env': 'config', 'settings': 'config',
    '__tests__': 'test', 'test': 'test', 'tests': 'test', 'spec': 'test', 'specs': 'test',
    'types': 'types', 'interfaces': 'types', 'schemas': 'types', 'contracts': 'types', 'dtos': 'types',
    'hooks': 'hooks',
    'store': 'state', 'state': 'state', 'reducers': 'state', 'actions': 'state', 'slices': 'state',
    'assets': 'assets', 'static': 'assets', 'public': 'assets',
    'migrations': 'data',
    'management': 'config', 'commands': 'config',
    'templatetags': 'utility',
    'signals': 'service',
    'serializers': 'api',
    'cmd': 'entry',
    'internal': 'service',
    'pkg': 'utility',
    'dto': 'types', 'request': 'types', 'response': 'types',
    'entity': 'data',
    'controller': 'api',
    'routers': 'api',
    'composables': 'service',
    'blueprints': 'api',
    'mailers': 'service', 'jobs': 'service', 'channels': 'service',
    'bin': 'entry',
    'docs': 'documentation', 'documentation': 'documentation', 'wiki': 'documentation',
    'deploy': 'infrastructure', 'deployment': 'infrastructure', 'infra': 'infrastructure', 'infrastructure': 'infrastructure',
    '.github': 'ci-cd', '.gitlab': 'ci-cd', '.circleci': 'ci-cd',
    'k8s': 'infrastructure', 'kubernetes': 'infrastructure', 'helm': 'infrastructure', 'charts': 'infrastructure',
    'terraform': 'infrastructure', 'tf': 'infrastructure',
    'docker': 'infrastructure',
    'sql': 'data', 'database': 'data', 'schema': 'data',

    // Project-specific
    'electron': 'ui',
    'reports': 'documentation',
    'send': 'service',
    'templates': 'documentation',
    '.claude': 'config',
    '.understand-anything': 'config',
  };
  return patterns[dirName] || null;
}

/** File-level pattern matching */
function matchFilePattern(fileName, filePath) {
  const lower = fileName.toLowerCase();
  const normPath = filePath.replace(/\\/g, '/');

  // Test files
  if (/\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(lower)) return 'test';
  if (/^test_/.test(lower) && /\.py$/.test(lower)) return 'test';
  if (/_test\.go$/.test(lower)) return 'test';
  if (/Test\.java$/.test(lower)) return 'test';
  if (/_spec\.rb$/.test(lower)) return 'test';
  if (/Test\.php$/.test(lower)) return 'test';
  if (/Tests\.cs$/.test(lower)) return 'test';

  // TypeScript declaration files
  if (/\.d\.ts$/.test(lower)) return 'types';

  // Index/entry files
  if (/^(index\.(ts|js|mjs|cjs))$/.test(lower)) return 'entry';
  if (/^__init__\.py$/.test(lower)) return 'entry';
  if (/^manage\.py$/.test(lower)) return 'entry';
  if (/^(wsgi|asgi)\.py$/.test(lower)) return 'config';
  if (/^main\.go$/i.test(lower) && /cmd\//.test(normPath)) return 'entry';
  if (/^(main|lib)\.rs$/i.test(lower) && /src\//.test(normPath)) return 'entry';
  if (/^(Application\.java|Program\.cs)$/i.test(lower)) return 'entry';
  if (/^config\.ru$/i.test(lower)) return 'entry';

  // Package manifests
  if (/^(Cargo\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle|composer\.json)$/i.test(lower)) return 'config';

  // Infrastructure
  if (/^Dockerfile/i.test(lower)) return 'infrastructure';
  if (/^docker-compose/i.test(lower)) return 'infrastructure';
  if (/\.tf$/.test(lower) || /\.tfvars$/.test(lower)) return 'infrastructure';

  // CI/CD
  if (/^Jenkinsfile$/i.test(lower)) return 'ci-cd';
  if (/\.(gitlab-ci|circleci)/.test(lower)) return 'ci-cd';

  // Data
  if (/\.sql$/i.test(lower)) return 'data';

  // Types
  if (/\.(graphql|gql|proto)$/i.test(lower)) return 'types';

  // Documentation
  if (/\.(md|rst)$/i.test(lower)) return 'documentation';

  // Infrastructure
  if (/^Makefile$/i.test(lower)) return 'infrastructure';

  // Project-specific
  if (/^启动工具\.bat$/i.test(lower)) return 'entry';
  if (/^fix-provider\.js$/i.test(lower)) return 'utility';

  return null;
}

// ─── A. DIRECTORY GROUPING ──────────────────────────────────────────
const directoryGroups = {};
for (const node of fileNodes) {
  const group = getDirGroup(node.filePath);
  if (!directoryGroups[group]) directoryGroups[group] = [];
  directoryGroups[group].push(node.id);
}

// ─── B. NODE TYPE GROUPING ──────────────────────────────────────────
const nodeTypeGroups = {};
for (const node of fileNodes) {
  if (!nodeTypeGroups[node.type]) nodeTypeGroups[node.type] = [];
  nodeTypeGroups[node.type].push(node.id);
}

// ─── C. IMPORT ADJACENCY MATRIX ─────────────────────────────────────
const fileFanIn = {};
const fileFanOut = {};
for (const node of fileNodes) {
  if (!fileFanIn[node.id]) fileFanIn[node.id] = 0;
  if (!fileFanOut[node.id]) fileFanOut[node.id] = 0;
}

// Build file-level import edges (filter to file→file edges only)
const fileLevelImportEdges = [];
const allImportEdges = importEdges || [];
const allEdgesArr = allEdges || [];

// From importEdges
for (const edge of allImportEdges) {
  if (allFileNodeIds.has(edge.source) && allFileNodeIds.has(edge.target)) {
    fileLevelImportEdges.push(edge);
    fileFanOut[edge.source] = (fileFanOut[edge.source] || 0) + 1;
    fileFanIn[edge.target] = (fileFanIn[edge.target] || 0) + 1;
  }
}

// From allEdges (calls, depends_on types that are file→file)
for (const edge of allEdgesArr) {
  if (allFileNodeIds.has(edge.source) && allFileNodeIds.has(edge.target)) {
    if (edge.type === 'calls' || edge.type === 'depends_on' || edge.type === 'imports') {
      // Avoid double-counting
      const alreadyCounted = fileLevelImportEdges.some(
        e => e.source === edge.source && e.target === edge.target && e.type === 'imports'
      );
      if (!alreadyCounted) {
        fileLevelImportEdges.push({...edge, type__normalized: 'imports'});
        fileFanOut[edge.source] = (fileFanOut[edge.source] || 0) + 1;
        fileFanIn[edge.target] = (fileFanIn[edge.target] || 0) + 1;
      }
    }
  }
}

// Group import stats
function getDirGroupForId(nodeId) {
  const node = fileNodes.find(n => n.id === nodeId);
  return node ? getDirGroup(node.filePath) : 'unknown';
}

// ─── D. CROSS-CATEGORY DEPENDENCY ANALYSIS ──────────────────────────
const crossCategoryEdges = [];
const ccMap = {}; // key: "fromType→toType→edgeType"

for (const edge of allEdgesArr) {
  const sourceNode = fileNodes.find(n => n.id === edge.source);
  const targetNode = fileNodes.find(n => n.id === edge.target);
  if (!sourceNode || !targetNode) continue;

  const fromType = sourceNode.type;
  const toType = targetNode.type;
  const edgeType = edge.type;

  // Skip contains edges (internal structure)
  if (edgeType === 'contains') continue;

  // Skip file→file import-style edges (covered by import analysis)
  if (fromType === 'file' && toType === 'file' &&
      (edgeType === 'imports' || edgeType === 'calls' || edgeType === 'depends_on')) continue;

  const key = `${fromType}→${toType}→${edgeType}`;
  if (!ccMap[key]) {
    ccMap[key] = { fromType, toType, edgeType, count: 0 };
  }
  ccMap[key].count++;
}

for (const key of Object.keys(ccMap)) {
  crossCategoryEdges.push(ccMap[key]);
}

// ─── E. INTER-GROUP IMPORT FREQUENCY ────────────────────────────────
const interGroupMap = {}; // key: "fromGroup→toGroup"
const groups = Object.keys(directoryGroups);

for (const edge of fileLevelImportEdges) {
  const fromGroup = getDirGroupForId(edge.source);
  const toGroup = getDirGroupForId(edge.target);
  if (fromGroup === toGroup) continue; // skip intra-group

  const key = `${fromGroup}→${toGroup}`;
  if (!interGroupMap[key]) interGroupMap[key] = { from: fromGroup, to: toGroup, count: 0 };
  interGroupMap[key].count++;
}

const interGroupImports = Object.values(interGroupMap);

// ─── F. INTRA-GROUP IMPORT DENSITY ──────────────────────────────────
const intraGroupDensity = {};
for (const group of groups) {
  let internalEdges = 0;
  let totalEdges = 0;

  for (const edge of fileLevelImportEdges) {
    const fromGroup = getDirGroupForId(edge.source);
    const toGroup = getDirGroupForId(edge.target);
    if (fromGroup === group || toGroup === group) {
      totalEdges++;
      if (fromGroup === group && toGroup === group) {
        internalEdges++;
      }
    }
  }

  intraGroupDensity[group] = {
    internalEdges,
    totalEdges,
    density: totalEdges > 0 ? internalEdges / totalEdges : 0,
  };
}

// ─── G. DIRECTORY PATTERN MATCHING ──────────────────────────────────
const patternMatches = {};
for (const group of groups) {
  // First try directory name pattern
  const dirPattern = matchDirectoryPattern(group);
  if (dirPattern) {
    patternMatches[group] = dirPattern;
    continue;
  }

  // If no directory pattern, try file-level patterns for files in the group
  const groupNodeIds = directoryGroups[group];
  let bestFilePattern = null;
  for (const nodeId of groupNodeIds) {
    const node = fileNodes.find(n => n.id === nodeId);
    if (!node) continue;
    const fp = matchFilePattern(node.name, node.filePath);
    if (fp) {
      bestFilePattern = fp;
      break;
    }
  }
  if (bestFilePattern) {
    patternMatches[group] = bestFilePattern;
  }
}

// ─── H. DEPLOYMENT TOPOLOGY DETECTION ───────────────────────────────
const infraFiles = [];
let hasDockerfile = false;
let hasCompose = false;
let hasK8s = false;
let hasTerraform = false;
let hasCI = false;

for (const node of fileNodes) {
  const lower = node.name.toLowerCase();
  const normPath = node.filePath.replace(/\\/g, '/');

  if (/^Dockerfile/i.test(lower)) { hasDockerfile = true; infraFiles.push(node.filePath); }
  if (/^docker-compose/i.test(lower)) { hasCompose = true; infraFiles.push(node.filePath); }
  if (/\.github\/workflows\//.test(normPath)) { hasCI = true; infraFiles.push(node.filePath); }
  if (/\.gitlab-ci\.yml/.test(lower)) { hasCI = true; infraFiles.push(node.filePath); }
  if (/^Jenkinsfile$/i.test(lower)) { hasCI = true; infraFiles.push(node.filePath); }
  if (/\.tf$/.test(lower)) { hasTerraform = true; infraFiles.push(node.filePath); }
  // K8s
  if (/(k8s|kubernetes|helm|charts)/.test(normPath)) { hasK8s = true; infraFiles.push(node.filePath); }
  // Makefile
  if (/^Makefile$/i.test(lower)) infraFiles.push(node.filePath);
}

const deploymentTopology = {
  hasDockerfile,
  hasCompose,
  hasK8s,
  hasTerraform,
  hasCI,
  infraFiles,
};

// ─── I. DATA PIPELINE DETECTION ─────────────────────────────────────
const schemaFiles = [];
const migrationFiles = [];
const dataModelFiles = [];
const apiHandlerFiles = [];

for (const node of fileNodes) {
  const lower = node.name.toLowerCase();
  const normPath = node.filePath.replace(/\\/g, '/');

  if (/\.sql$/i.test(lower)) schemaFiles.push(node.filePath);
  if (/migration/.test(normPath)) migrationFiles.push(node.filePath);
  if (/\.(graphql|gql|proto|prisma)$/i.test(lower)) schemaFiles.push(node.filePath);

  // Data model files — files in models/ or entities/ directories, or named with "model" or "schema"
  if (/(models|entities|schemas)\//.test(normPath) || /model/.test(lower)) {
    dataModelFiles.push(node.filePath);
  }

  // API handler files
  if (/(routes|api|controllers|endpoints|handlers)\//.test(normPath)) {
    apiHandlerFiles.push(node.filePath);
  }
}

// Also add data JSON configs as data models for this project
for (const node of fileNodes) {
  if (node.filePath.startsWith('data/')) {
    if (!dataModelFiles.includes(node.filePath)) {
      dataModelFiles.push(node.filePath);
    }
  }
}

const dataPipeline = {
  schemaFiles,
  migrationFiles,
  dataModelFiles,
  apiHandlerFiles,
};

// ─── J. DOCUMENTATION COVERAGE ──────────────────────────────────────
const groupsWithDocs = new Set();
const undocumentedGroups = [];

for (const group of groups) {
  const groupNodeIds = directoryGroups[group];
  let hasDoc = false;
  for (const nodeId of groupNodeIds) {
    const node = fileNodes.find(n => n.id === nodeId);
    if (!node) continue;
    const lower = node.name.toLowerCase();
    const normPath = node.filePath.replace(/\\/g, '/');

    // Check for README or .md files
    if (/^readme\.(md|rst)$/i.test(lower)) { hasDoc = true; break; }
    // Check if docs directory has files
    if (group === 'docs') { hasDoc = true; break; }
    // Check for any .md file
    if (/\.(md|rst)$/i.test(lower) && node.type === 'document') { hasDoc = true; break; }
  }
  if (hasDoc) {
    groupsWithDocs.add(group);
  } else {
    undocumentedGroups.push(group);
  }
}

const totalGroups = groups.length;
const docCoverage = {
  groupsWithDocs: groupsWithDocs.size,
  totalGroups,
  coverageRatio: totalGroups > 0 ? groupsWithDocs.size / totalGroups : 0,
  undocumentedGroups,
};

// ─── K. DEPENDENCY DIRECTION ────────────────────────────────────────
const dependencyDirection = [];
const directionMap = {}; // key: "A→B" => { fromAtoB: N, fromBtoA: M }

for (const edge of fileLevelImportEdges) {
  const fromGroup = getDirGroupForId(edge.source);
  const toGroup = getDirGroupForId(edge.target);
  if (fromGroup === toGroup) continue;

  const key = `${fromGroup}→${toGroup}`;
  const revKey = `${toGroup}→${fromGroup}`;
  if (!directionMap[key]) directionMap[key] = { fromAtoB: 0, fromBtoA: 0, groupA: fromGroup, groupB: toGroup };
  directionMap[key].fromAtoB++;
}

// Determine dominant direction
const pairProcessed = new Set();
for (const key of Object.keys(directionMap)) {
  const { groupA, groupB, fromAtoB, fromBtoA } = directionMap[key];
  const pairKey = [groupA, groupB].sort().join('::');

  // Also look for the reverse
  const revKey = `${groupB}→${groupA}`;
  const rev = directionMap[revKey] || { fromAtoB: 0, fromBtoA: 0 };

  const totalAToB = fromAtoB + (rev ? rev.fromBtoA : 0);
  const totalBToA = (rev ? rev.fromAtoB : 0) + fromBtoA;

  if (pairProcessed.has(pairKey)) continue;
  pairProcessed.add(pairKey);

  if (totalAToB > totalBToA && totalAToB > 0) {
    dependencyDirection.push({ dependent: groupA, dependsOn: groupB });
  } else if (totalBToA > totalAToB && totalBToA > 0) {
    dependencyDirection.push({ dependent: groupB, dependsOn: groupA });
  }
}

// ─── FILE STATS ─────────────────────────────────────────────────────
const fileStats = {
  totalFileNodes: fileNodes.length,
  filesPerGroup: {},
  nodeTypeCounts: {},
};

for (const group of groups) {
  fileStats.filesPerGroup[group] = (directoryGroups[group] || []).length;
}
for (const node of fileNodes) {
  fileStats.nodeTypeCounts[node.type] = (fileStats.nodeTypeCounts[node.type] || 0) + 1;
}

// ─── OUTPUT ─────────────────────────────────────────────────────────
const result = {
  scriptCompleted: true,
  directoryGroups,
  nodeTypeGroups,
  crossCategoryEdges,
  interGroupImports,
  intraGroupDensity,
  patternMatches,
  deploymentTopology,
  dataPipeline,
  docCoverage,
  dependencyDirection,
  fileStats,
  fileFanIn,
  fileFanOut,
};

try {
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
} catch (e) {
  console.error('Failed to write output JSON:', e.message);
  process.exit(1);
}

process.exit(0);
