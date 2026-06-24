#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// Parse arguments
const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("Usage: node ua-tour-analyze.js <input.json> <output.json>");
  process.exit(1);
}

// Read input
let input;
try {
  input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (e) {
  console.error("Failed to read input file:", e.message);
  process.exit(1);
}

const { nodes, edges, layers } = input;

// ===================== H. Node Summary Index =====================
const nodeSummaryIndex = {};
for (const node of nodes) {
  nodeSummaryIndex[node.id] = {
    name: node.name,
    type: node.type,
    summary: node.summary || "",
  };
}

// ===================== A. Fan-In Ranking (Importance) =====================
const fanInMap = {};
for (const node of nodes) {
  fanInMap[node.id] = 0;
}
for (const edge of edges) {
  if (edge.direction === "forward" || edge.direction === "bidirectional") {
    fanInMap[edge.target] = (fanInMap[edge.target] || 0) + 1;
  }
  if (edge.direction === "bidirectional") {
    fanInMap[edge.source] = (fanInMap[edge.source] || 0) + 1;
  }
}

const fanInRanking = Object.entries(fanInMap)
  .map(([id, fanIn]) => {
    const info = nodeSummaryIndex[id] || { name: id, type: "unknown" };
    return { id, fanIn, name: info.name };
  })
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 20);

// ===================== B. Fan-Out Ranking (Scope) =====================
const fanOutMap = {};
for (const node of nodes) {
  fanOutMap[node.id] = 0;
}
for (const edge of edges) {
  if (edge.direction === "forward" || edge.direction === "bidirectional") {
    fanOutMap[edge.source] = (fanOutMap[edge.source] || 0) + 1;
  }
  if (edge.direction === "bidirectional") {
    fanOutMap[edge.target] = (fanOutMap[edge.target] || 0) + 1;
  }
}

const fanOutRanking = Object.entries(fanOutMap)
  .map(([id, fanOut]) => {
    const info = nodeSummaryIndex[id] || { name: id, type: "unknown" };
    return { id, fanOut, name: info.name };
  })
  .sort((a, b) => b.fanOut - a.fanOut)
  .slice(0, 20);

// Helper: get all fan-out values for percentile calculation
const allFanOuts = Object.values(fanOutMap).sort((a, b) => a - b);
const allFanIns = Object.values(fanInMap).sort((a, b) => a - b);
const fanOutTop10Threshold = allFanOuts[Math.ceil(allFanOuts.length * 0.9) - 1] || 0;
const fanInBottom25Threshold = allFanIns[Math.ceil(allFanIns.length * 0.25) - 1] || 0;

// ===================== C. Entry Point Candidates =====================
const entryPointFileNames = [
  "index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.js",
  "server.ts", "server.js", "mod.rs", "main.go", "main.py", "main.rs",
  "manage.py", "app.py", "wsgi.py", "asgi.py", "run.py", "__main__.py",
  "Application.java", "Main.java", "Program.cs", "config.ru", "index.php",
  "App.swift", "Application.kt", "main.cpp", "main.c"
];

function scoreEntryPoint(node) {
  let score = 0;

  if (node.type === "file") {
    const fileName = (node.filePath || "").split("/").pop().split("\\").pop();
    const baseName = fileName || "";

    // filename matches entry point patterns
    if (entryPointFileNames.includes(baseName)) {
      score += 3;
    }

    // at project root or one level deep
    const depth = (node.filePath || "").split("/").filter(s => s).length;
    // Count path segments excluding the filename itself
    const pathParts = (node.filePath || "").split("/").filter(s => s && s !== baseName);
    if (pathParts.length <= 1) {
      score += 1;
    }

    // high fan-out (top 10%)
    const fo = fanOutMap[node.id] || 0;
    if (fo >= fanOutTop10Threshold && fo > 0) {
      score += 1;
    }

    // low fan-in (bottom 25%)
    const fi = fanInMap[node.id] || 0;
    if (fi <= fanInBottom25Threshold) {
      score += 1;
    }
  }

  if (node.type === "document") {
    const fileName = (node.filePath || "").split("/").pop().split("\\").pop();
    if (fileName === "README.md" && (node.filePath === "README.md" || node.filePath.endsWith("/README.md") || node.filePath.endsWith("\\README.md"))) {
      score += 5;
    } else if (fileName && fileName.endsWith(".md")) {
      const depth = (node.filePath || "").split("/").filter(s => s).length;
      const pathParts = (node.filePath || "").split("/").filter(s => s && s !== fileName);
      if (pathParts.length === 0) {
        score += 2;
      }
    }
  }

  return score;
}

const entryPointCandidates = nodes
  .map(node => ({
    id: node.id,
    score: scoreEntryPoint(node),
    name: node.name,
    summary: node.summary || "",
  }))
  .filter(c => c.score > 0)
  .sort((a, b) => b.score - a.fanIn)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

// ===================== D. Dependency Chains (BFS from Entry Points) =====================
// Find top code entry point (skip documentation)
const topCodeEntry = entryPointCandidates.find(c => {
  const node = nodeSummaryIndex[c.id];
  return node && node.type === "file";
});

let bfsTraversal = { order: [], depthMap: {}, byDepth: {}, startNode: null };

if (topCodeEntry) {
  bfsTraversal.startNode = topCodeEntry.id;

  // Build adjacency list (forward edges: imports, calls, depends_on)
  const adj = {};
  for (const node of nodes) {
    adj[node.id] = [];
  }
  for (const edge of edges) {
    if (["imports", "calls", "depends_on"].includes(edge.type)) {
      if (!adj[edge.source]) adj[edge.source] = [];
      adj[edge.source].push(edge.target);
      // also follow bidirectional
      if (!adj[edge.target]) adj[edge.target] = [];
    }
  }

  // BFS
  const visited = new Set();
  const queue = [{ id: topCodeEntry.id, depth: 0 }];
  visited.add(topCodeEntry.id);

  const order = [];
  const depthMap = {};
  const byDepth = {};

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    order.push(id);
    depthMap[id] = depth;
    if (!byDepth[depth]) byDepth[depth] = [];
    byDepth[depth].push(id);

    const neighbors = adj[id] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }

  bfsTraversal.order = order;
  bfsTraversal.depthMap = depthMap;
  bfsTraversal.byDepth = byDepth;
}

// ===================== E. Non-Code File Inventory =====================
const nonCodeFiles = {
  documentation: [],
  infrastructure: [],
  data: [],
  config: [],
};

for (const node of nodes) {
  const entry = { id: node.id, name: node.name, summary: node.summary || "" };
  switch (node.type) {
    case "document":
      nonCodeFiles.documentation.push(entry);
      break;
    case "service":
    case "pipeline":
    case "resource":
      nonCodeFiles.infrastructure.push(entry);
      break;
    case "table":
    case "schema":
    case "endpoint":
      nonCodeFiles.data.push(entry);
      break;
    case "config":
      nonCodeFiles.config.push(entry);
      break;
  }
}

// ===================== F. Tightly Coupled Clusters =====================
// Build an edge set between node pairs (undirected, weighted)
const pairEdges = {};
for (const edge of edges) {
  const [a, b] = [edge.source, edge.target].sort();
  const key = a + "|||" + b;
  if (!pairEdges[key]) pairEdges[key] = { nodes: [a, b], count: 0 };
  pairEdges[key].count += 1;
}

// Find bidirectional pairs (count >= 2 between same pair)
const bidirectionalPairs = Object.values(pairEdges)
  .filter(p => p.count >= 2)
  .map(p => p.nodes);

// Build adjacency for clustering
const clusterAdj = {};
for (const node of nodes) {
  clusterAdj[node.id] = new Set();
}
for (const edge of edges) {
  if (clusterAdj[edge.source]) clusterAdj[edge.source].add(edge.target);
  if (clusterAdj[edge.target]) clusterAdj[edge.target].add(edge.source);
}

// Find clusters: groups where each node connects to 2+ others in the group
const clusters = [];
const assigned = new Set();

// Start with bidirectional pairs
for (const pair of bidirectionalPairs) {
  const [a, b] = pair;
  if (assigned.has(a) && assigned.has(b)) continue;

  let cluster = new Set([a, b]);

  // Try to expand
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of Object.keys(clusterAdj)) {
      if (cluster.has(nodeId)) continue;
      const neighbors = clusterAdj[nodeId] || new Set();
      let connectionCount = 0;
      for (const member of cluster) {
        if (neighbors.has(member)) connectionCount++;
      }
      if (connectionCount >= 2) {
        cluster.add(nodeId);
        changed = true;
      }
    }
  }

  const clusterArr = Array.from(cluster);
  if (clusterArr.length >= 2 && clusterArr.length <= 5) {
    // Count internal edges
    let internalEdges = 0;
    for (let i = 0; i < clusterArr.length; i++) {
      for (let j = i + 1; j < clusterArr.length; j++) {
        const key1 = clusterArr[i] + "|||" + clusterArr[j];
        const key2 = clusterArr[j] + "|||" + clusterArr[i];
        if (pairEdges[key1]) internalEdges += pairEdges[key1].count;
        if (pairEdges[key2]) internalEdges += pairEdges[key2].count;
      }
    }
    clusters.push({ nodes: clusterArr, edgeCount: internalEdges });
    for (const n of clusterArr) assigned.add(n);
  }
}

// Find additional clusters from remaining unassigned nodes
const remaining = nodes.filter(n => !assigned.has(n.id) && n.type === "file");
const visitedForCluster = new Set();

for (const node of remaining) {
  if (visitedForCluster.has(node.id)) continue;
  const component = [];
  const stack = [node.id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (visitedForCluster.has(cur)) continue;
    visitedForCluster.add(cur);
    component.push(cur);
    for (const neighbor of (clusterAdj[cur] || [])) {
      if (!visitedForCluster.has(neighbor) && !assigned.has(neighbor)) {
        stack.push(neighbor);
      }
    }
  }
  if (component.length >= 2 && component.length <= 5) {
    let internalEdges = 0;
    for (let i = 0; i < component.length; i++) {
      for (let j = i + 1; j < component.length; j++) {
        const key1 = component[i] + "|||" + component[j];
        const key2 = component[j] + "|||" + component[i];
        if (pairEdges[key1]) internalEdges += pairEdges[key1].count;
        if (pairEdges[key2]) internalEdges += pairEdges[key2].count;
      }
    }
    clusters.push({ nodes: component, edgeCount: internalEdges });
  }
}

// Sort by edge count descending, take top 10
clusters.sort((a, b) => b.edgeCount - a.edgeCount);
const topClusters = clusters.slice(0, 10);

// ===================== G. Layer List =====================
const layerList = {
  count: layers ? layers.length : 0,
  list: layers ? layers.map(l => ({ id: l.id, name: l.name, description: l.description })) : [],
};

// ===================== OUTPUT =====================
const output = {
  scriptCompleted: true,
  entryPointCandidates,
  fanInRanking,
  fanOutRanking,
  bfsTraversal,
  nonCodeFiles,
  clusters: topClusters,
  layers: layerList,
  nodeSummaryIndex,
  totalNodes: nodes.length,
  totalEdges: edges.length,
};

try {
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
} catch (e) {
  console.error("Failed to write output:", e.message);
  process.exit(1);
}

console.log("Analysis complete. Results written to: " + outputPath);
process.exit(0);
