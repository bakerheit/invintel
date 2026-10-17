import type { LoginInput, RegisterInput, RegisterResult, User } from "@invintel/shared";
import { create } from "zustand";
import { api, setUnauthorizedHandler } from "@/lib/api";
import { clearLastOrg } from "@/lib/last-org";
import { queryClient } from "@/lib/query";

interface AuthState {
  user: User | null;
  /** "loading" until the first /auth/me check finishes. */
  status: "loading" | "ready";
  init: () => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<RegisterResult>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: "loading",
  init: async () => {
    const user = await api.me().catch(() => null);
    set({ user, status: "ready" });
  },
  login: async (input) => {
    queryClient.clear();
    set({ user: await api.login(input) });
  },
  register: async (input) => {
    queryClient.clear();
    const result = await api.register(input);
    set({ user: result.user });
    return result;
  },
  logout: async () => {
    await api.logout().catch(() => {});
    queryClient.clear();
    clearLastOrg();
    set({ user: null });
  },
}));

setUnauthorizedHandler(() => {
  queryClient.clear();
  useAuth.setState({ user: null });
});
