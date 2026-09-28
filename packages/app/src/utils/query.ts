import { useQuery as useSuspendingQuery } from "@tanstack/solid-query"

export { skipToken, useMutation, useQueryClient, queryOptions } from "@tanstack/solid-query"

export const useQuery: typeof useSuspendingQuery = ((...args: Parameters<typeof useSuspendingQuery>) => {
  const query = useSuspendingQuery(...args)
  return new Proxy(query, {
    get(target, property, receiver) {
      if (property === "data" && target.isPending) return undefined
      return Reflect.get(target, property, receiver)
    },
  })
}) as typeof useSuspendingQuery

export const createQuery = useQuery
