// Remembers which organization you were last in. A convenience only, so any storage failure is ignored.
const KEY = "invintel:last-org";

export const getLastOrg = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const setLastOrg = (id: string) => {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
};

export const clearLastOrg = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};
