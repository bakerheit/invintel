import type { OrgSummary } from "@invintel/shared";
import { Check, ChevronsUpDown, Factory, History, LayoutDashboard, LogOut, ShieldCheck, MapPin, Monitor, Moon, Package, Plus, ScanLine, Settings, Sun } from "lucide-react";
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
import { type Theme, useTheme } from "@/lib/theme";
import { useAuth } from "@/stores/auth";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export const navItems = (orgId: string) => [
  { to: `/o/${orgId}`, end: true, label: "Overview", icon: LayoutDashboard, adminOnly: false },
  { to: `/o/${orgId}/inventory`, end: false, label: "Inventory", icon: Package, adminOnly: false },
  { to: `/o/${orgId}/activity`, end: false, label: "Activity", icon: History, adminOnly: false },
  { to: `/o/${orgId}/locations`, end: false, label: "Locations", icon: MapPin, adminOnly: false },
  { to: `/o/${orgId}/production`, end: false, label: "Production", icon: Factory, adminOnly: false },
  { to: `/o/${orgId}/audit`, end: false, label: "Audit log", icon: ShieldCheck, adminOnly: true },
  { to: `/o/${orgId}/settings`, end: false, label: "Settings", icon: Settings, adminOnly: false },
];

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
  const { theme, setTheme } = useTheme();
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
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
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
              {navItems(org.id).filter((n) => !n.adminOnly || org.role !== "member").map(({ to, end, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    isActive={end ? pathname === to : pathname.startsWith(to)}
                    render={<Link to={to} onClick={() => setOpenMobile(false)} />}
                  >
                    <Icon />
                    <span>{label}</span>
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
