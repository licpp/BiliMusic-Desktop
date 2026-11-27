import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountEpoch } from '../../services/accountScope'
import { clearSearchHistory, listSearchHistory } from '../../services/desktopApi'
import { accountKeyAt, accountQueryKey } from '../../services/queryKeys'

const empty: string[] = []

export function useSearchHistory() {
  const client = useQueryClient()
  const { data = empty } = useQuery({ queryKey: accountQueryKey('search-history'), queryFn: listSearchHistory })
  const clear = useMutation({
    mutationFn: async (epoch: number) => {
      if (epoch === accountEpoch()) await clearSearchHistory()
    },
    onSuccess: async (_, epoch) => {
      if (epoch !== accountEpoch()) return
      const key = accountKeyAt(epoch, 'search-history')
      await client.cancelQueries({ queryKey: key })
      if (epoch === accountEpoch()) client.setQueryData(key, empty)
    },
  })
  return { history: data, onClear: () => clear.mutate(accountEpoch()), clearing: clear.isPending }
}
