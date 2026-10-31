// Presenter support for the synthetic demo (only used when the server runs in demo mode).

export interface DemoPersona {
  email: string;
  name: string;
  role: string;
  story: string;
}

/** Personas in the order the demo story is told. */
export const DEMO_PERSONAS: DemoPersona[] = [
  { email: "omar.haddad@example.com", name: "Omar Haddad", role: "Outgoing employee", story: "Writes the Orion handover before leaving" },
  { email: "maya.chen@example.com", name: "Maya Chen", role: "Manager", story: "Reviews, approves and monitors transfers" },
  { email: "lina.park@example.com", name: "Lina Park", role: "Incoming employee", story: "Onboards with the source-cited assistant" },
  { email: "theo.martin@example.com", name: "Theo Martin", role: "Administrator", story: "Audit trail and integration health" },
  { email: "priya.nair@example.com", name: "Priya Nair", role: "Manager, other project", story: "Shows project isolation (sees nothing of Orion)" },
  { email: "sam.rivera@example.com", name: "Sam Rivera", role: "Employee, other project", story: "Shows project isolation (Vega only)" },
];

export const personaByEmail = (email: string) => DEMO_PERSONAS.find((p) => p.email === email);

/**
 * Example answers for the fields the seed leaves empty on purpose, so the presenter can complete
 * the handover without typing. Synthetic text only.
 */
export const SAMPLE_ANSWERS: Record<string, string> = {
  "team.escalationPath": "First the on-call developer, then Maya Chen, then the Cloud Operations duty manager.",
  "risks.tacitKnowledge":
    "Northwind's IT service manager expects a written summary after every Thursday status call. The AS/400 team only answers on weekdays before 15:00, so plan Sync Worker fixes early in the week.",
};

export interface DemoState {
  available: boolean;
  projectId?: string;
  handoverId?: string | null;
  handoverStatus?: string | null;
  publicationStatus?: string | null;
  askedAfterApproval?: boolean;
}
