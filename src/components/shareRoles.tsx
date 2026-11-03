import { Crown, Pencil, Eye } from "lucide-react";

// The three sharing roles, in one place — the Profile panel (manage access) and
// the Cloud panel (incoming invites) both render them, and a role reading
// "Editor" in one screen and "editor" in the other is exactly the kind of drift
// that made sharing feel like two unrelated features.

export const roleMeta: Record<string, { label: string; icon: any; cls: string }> = {
  owner:  { label: "Owner",  icon: Crown,  cls: "text-warning bg-warning/[0.12]" },
  editor: { label: "Editor", icon: Pencil, cls: "text-info bg-info/[0.12]" },
  user:   { label: "Viewer", icon: Eye,    cls: "text-zinc-400 bg-white/[0.06]" },
};

export function RoleBadge({ role }: { role: string }) {
  const m = roleMeta[role] ?? roleMeta.user;
  const I = m.icon;
  return (
    <span className={`pill h-[18px] ${m.cls}`}>
      <I size={11} aria-hidden /> {m.label}
    </span>
  );
}

// What each role can actually do, in the user's words — shown next to the role
// picker so "Editor vs Viewer" doesn't require reading the docs.
export const roleBlurb: Record<string, string> = {
  editor: "Can use and change this profile.",
  user: "Can use it, but can't change anything.",
};
