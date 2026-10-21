import type { OrgModules, OrgSummary } from "@invintel/shared";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Bell, Check, Handshake, Mail, ChevronsUpDown, ClipboardCheck, Factory, History, LayoutDashboard, LogOut, ShieldAlert, ShieldCheck, MapPin, Monitor, Moon, Package, Plus, Printer, Receipt, Wallet, ScanLine, Settings, ShoppingCart, Sun } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { Wordmark } from "@/components/brand";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { orgKey, isAdmin } from "@/lib/org";
import { useQuery } from "@tanstack/react-query";
import { PALETTES, type Palette, type Theme, useTheme } from "@/lib/theme";
import { useAuth } from "@/stores/auth";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

interface NavItem { to: string; end: boolean; label: string; icon: LucideIcon; adminOnly: boolean; module?: keyof OrgModules }

export const navItems = (orgId: string): NavItem[] => [
  { to: `/o/${orgId}`, end: true, label: "Overview", icon: LayoutDashboard, adminOnly: false },
  { to: `/o/${orgId}/inventory`, end: false, label: "Inventory", icon: Package, adminOnly: false },
  { to: `/o/${orgId}/exchange`, end: false, label: "Exchange", icon: Handshake, adminOnly: false },
  { to: `/o/${orgId}/counts`, end: false, label: "Counts", icon: ClipboardCheck, adminOnly: false },
  { to: `/o/${orgId}/purchasing`, end: false, label: "Purchasing", icon: ShoppingCart, adminOnly: false, module: "purchasing" },
  { to: `/o/${orgId}/sales`, end: false, label: "Sales", icon: Receipt, adminOnly: false, module: "sales" },
  { to: `/o/${orgId}/payables`, end: false, label: "Payables", icon: Wallet, adminOnly: false, module: "purchasing" },
  { to: `/o/${orgId}/production`, end: false, label: "Production", icon: Factory, adminOnly: false, module: "production" },
  { to: `/o/${orgId}/quality`, end: false, label: "Quality", icon: ShieldAlert, adminOnly: false },
  { to: `/o/${orgId}/documents`, end: false, label: "Documents", icon: Mail, adminOnly: false },
  { to: `/o/${orgId}/alerts`, end: false, label: "Alerts", icon: Bell, adminOnly: false },
  { to: `/o/${orgId}/approvals`, end: false, label: "Approvals", icon: ShieldCheck, adminOnly: false },
  { to: `/o/${orgId}/reports`, end: false, label: "Reports", icon: BarChart3, adminOnly: false },
  { to: `/o/${orgId}/activity`, end: false, label: "Activity", icon: History, adminOnly: false },
  { to: `/o/${orgId}/locations`, end: false, label: "Locations", icon: MapPin, adminOnly: false },
  { to: `/o/${orgId}/audit`, end: false, label: "Audit log", icon: ShieldCheck, adminOnly: true },
  { to: `/o/${orgId}/settings`, end: false, label: "Settings", icon: Settings, adminOnly: false },
];

/** The pages this person should see: admin-only pages for admins, switched-off modules hidden. */
export const visibleNav = (org: OrgSummary) =>
  navItems(org.id).filter((n) => (!n.adminOnly || org.role !== "member") && (!n.module || org.modules[n.module]));

function OrgSwitcher({ org, orgs }: { org: OrgSummary; orgs: OrgSummary[] }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const go = (to: string) => {
    setOpenMobile(false);
    navigate(to);
  };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <Avatar className="size-8 rounded-lg after:rounded-lg">
              <AvatarFallback className="rounded-lg bg-accent text-xs font-semibold text-accent-foreground">
                {initials(org.name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{org.name}</span>
              <span className="truncate text-xs capitalize text-muted-foreground">{org.role}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-60"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={8}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {orgs.map((o) => (
                <DropdownMenuItem key={o.id} onClick={() => go(`/o/${o.id}`)}>
                  <Avatar className="size-6 rounded-md after:rounded-md">
                    <AvatarFallback className="rounded-md bg-accent text-[10px] font-semibold text-accent-foreground">
                      {initials(o.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate">{o.name}</span>
                  {o.id === org.id && <Check className="size-4 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => go("/orgs/new")}>
              <div className="flex size-6 items-center justify-center rounded-md border border-dashed">
                <Plus className="size-3.5" />
              </div>
              Create or join another
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { theme, setTheme, palette, setPalette } = useTheme();
  const { isMobile } = useSidebar();
  if (!user) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <Avatar className="size-8">
              <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            align="end"
            side={isMobile ? "top" : "right"}
            sideOffset={8}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                <DropdownMenuRadioItem value="light"><Sun /> Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark"><Moon /> Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system"><Monitor /> System</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Colour</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={palette} onValueChange={(v) => setPalette(v as Palette)}>
                {PALETTES.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id}>
                    <span className="size-3.5 rounded-full border" style={{ background: p.swatch }} aria-hidden /> {p.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void logout()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function AppSidebar({ org, orgs }: { org: OrgSummary; orgs: OrgSummary[] }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  // A number next to Approvals when something is waiting for this person to decide.
  const pending = useQuery({ queryKey: orgKey(org.id, "approvals", "pending-count"), queryFn: () => api.pendingApprovals(org.id), enabled: isAdmin(org.role), refetchInterval: 30_000 });

  const alerts = useQuery({ queryKey: orgKey(org.id, "alerts", "open-count"), queryFn: () => api.alerts(org.id), refetchInterval: 60_000 });

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="gap-3">
        <Link to={`/o/${org.id}`} className="px-2 pt-1" aria-label="Invintel home">
          <Wordmark />
        </Link>
        <OrgSwitcher org={org} orgs={orgs} />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleNav(org).map(({ to, end, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    isActive={end ? pathname === to : pathname.startsWith(to)}
                    render={<Link to={to} onClick={() => setOpenMobile(false)} />}
                  >
                    <Icon />
                    <span>{label}</span>
                    {label === "Alerts" && (alerts.data?.open.total ?? 0) > 0 && (
                      <span className={`ml-auto rounded-full px-1.5 text-xs font-semibold ${alerts.data!.open.critical ? "bg-destructive text-white" : "bg-sidebar-primary text-sidebar-primary-foreground"}`} aria-label={`${alerts.data!.open.total} open`}>{alerts.data!.open.total}</span>
                    )}
                    {label === "Approvals" && (pending.data?.count ?? 0) > 0 && (
                      <span className="ml-auto rounded-full bg-sidebar-primary px-1.5 text-xs font-semibold text-sidebar-primary-foreground" aria-label={`${pending.data!.count} waiting`}>{pending.data!.count}</span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.startsWith(`/o/${org.id}/labels`)}
                  render={<Link to={`/o/${org.id}/labels`} onClick={() => setOpenMobile(false)} />}
                >
                  <Printer />
                  <span>Labels</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to={`/o/${org.id}/floor`} onClick={() => setOpenMobile(false)} />}>
                  <ScanLine />
                  <span>Floor mode</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
