/**
 * Org chart projection and markdown (design-org §5): a serializable,
 * deterministically ordered view of the establishment.
 */
import type { Department } from './types.js';

export interface OrgChartView {
  departmentId: string;
  name: string;
  mission: string;
  lead?: string;
  headcount: number;
  members: Array<{ agentId: string; role: string; title?: string; skills: string[] }>;
}

function sortedDepts(departments: Department[]): Department[] {
  return [...departments].sort((a, b) => a.departmentId.localeCompare(b.departmentId));
}

export function buildOrgChart(departments: Department[]): OrgChartView[] {
  return sortedDepts(departments).map(d => ({
    departmentId: d.departmentId,
    name: d.name,
    mission: d.mission,
    ...(d.lead ? { lead: d.lead } : {}),
    headcount: d.members.length,
    members: [...d.members]
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map(m => ({
        agentId: m.agentId,
        role: m.role,
        ...(m.title ? { title: m.title } : {}),
        skills: m.skills ?? [],
      })),
  }));
}

export function renderOrgMarkdown(departments: Department[]): string {
  const out: string[] = ['# Org chart', ''];
  for (const d of sortedDepts(departments)) {
    out.push(`## ${d.name} · ${d.departmentId}`);
    out.push(`> Mission: ${d.mission}`);
    if (d.lead) out.push(`- **Lead:** ${d.lead}`);
    for (const m of [...d.members].sort((a, b) => a.agentId.localeCompare(b.agentId))) {
      if (m.agentId === d.lead) continue;
      const title = m.title ? ` — ${m.title}` : '';
      const skills = m.skills && m.skills.length ? ` (${m.skills.join(', ')})` : '';
      out.push(`- ${m.agentId}${title}${skills} [${m.role}]`);
    }
    out.push('');
  }
  return out.join('\n');
}
