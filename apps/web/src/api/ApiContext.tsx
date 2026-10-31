import { createContext, type ReactNode, useContext } from "react";
import type { JJApi } from "./client";

const ApiContext = createContext<JJApi | null>(null);

export function ApiProvider({
  api,
  children,
}: {
  api: JJApi;
  children: ReactNode;
}) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): JJApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside <ApiProvider>");
  return api;
}
