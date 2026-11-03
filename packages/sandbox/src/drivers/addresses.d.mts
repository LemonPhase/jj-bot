// Types of the egress proxy's address check, for TypeScript packages that
// reuse it (`@jj/sandbox/addresses`) without compiling JavaScript. The proxy
// program (`egress-proxy.mjs`) must stay one self-contained file, which is
// why its types are declared here rather than exported from a module.

/**
 * Whether an address (IPv4, or IPv6 as resolvers return it) is public: global
 * unicast outside every special-purpose range. IPv4-mapped IPv6 is judged as
 * the IPv4 address it carries. Anything unparseable is not public.
 */
export function isPublicAddress(address: string): boolean;
