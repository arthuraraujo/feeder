import { values, autorun } from "mobx"
import { sumBy, max, map, orderBy, flatten } from "lodash"
import { types as t, destroy } from "mobx-state-tree"
import { remote } from "electron"
import { parseOPML } from "support/opml"

import Item from "./Item"
import Source from "./Source"

const disposables = []

export default t
  .model("Store", {
    sources: t.optional(t.map(Source), {}),
    concurrency: t.optional(t.number, 4),
    filter: t.optional(t.string, ""),
    mode: t.optional(t.enumeration(["split", "stream"]), "split"),
    activeSourceIndex: t.optional(t.number, -1),
    activeItem: t.maybeNull(
      t.reference(Item, {
        onInvalidated(e) {
          e.removeRef()
        },
      }),
    ),
  })
  .views((self) => ({
    get newItemsCount() {
      return sumBy(self.allSources, "newItemsCount")
    },
    get updatedAt() {
      return max(map(self.allSources, "updatedAt"))
    },
    get pending() {
      return self.allSources.filter((source) => source.status === "pending")
    },
    get running() {
      return self.allSources.filter((source) => source.status === "running")
    },
    get done() {
      return values(self.sources).filter((source) => source.status === "done")
    },
    get progress() {
      return (
        (self.allSources.length - self.pending.length) / self.allSources.length
      )
    },
    get allSources() {
      return values(self.sources)
    },
    get allSourceItems() {
      return orderBy(
        flatten(map(self.allSources, "allItems")),
        "publishedAt",
        "desc",
      )
    },
    get sortedSources() {
      return orderBy(
        self.allSources,
        [(s) => Number(s.publishedAt), "newItemsCount", "title"],
        ["desc", "desc", "asc"],
      )
    },
    get sortedItems() {
      if (self.activeSource) {
        return self.activeSource.sortedItems
      }

      return self.allSourceItems
    },
    get filteredItems() {
      const regex = new RegExp(self.filter, "i")
      return self.sortedItems.filter((item) => {
        if (self.filter.length > 0) {
          return Object.values(item).some((x) => regex.test(x))
        }
        return true
      })
    },
    get activeSource() {
      return self.sortedSources[self.activeSourceIndex]
    },
    get activeItemIndex() {
      return self.filteredItems.indexOf(self.activeItem)
    },
  }))
  .actions((self) => ({
    afterCreate() {
      disposables.push(
        autorun(() => {
          remote.app.badgeCount = self.newItemsCount
        }),
      )

      disposables.push(
        autorun(() => {
          self.setActiveItem(self.filteredItems[0])
        }),
      )

      disposables.push(
        autorun(() => {
          if (
            self.activeItem?.source.readability &&
            !self.activeItem?.readableDescription
          ) {
            self.activeItem.makeReadable()
          }
        }),
      )

      disposables.push(
        autorun(async () => {
          if (
            navigator.onLine &&
            self.pending.length > 0 &&
            self.running.length < self.concurrency
          ) {
            const source = self.pending.shift()
            source.fetch()
          }
        }),
      )
    },
    afterDestroy() {
      disposables.forEach((dispose) => dispose())
    },
    setActiveSource(source) {
      self.activeSourceIndex = self.sortedSources.indexOf(source)
    },
    setActiveItem(value) {
      self.activeItem = value
    },
    advanceItem(direction) {
      const nextIndex = self.activeItemIndex + direction
      if (self.filteredItems[nextIndex]) {
        self.setActiveItem(self.filteredItems[nextIndex])
        return nextIndex
      }
      return -1
    },
    advanceSource(direction) {
      const nextIndex = self.activeSourceIndex + direction
      if (nextIndex >= -1 && nextIndex < self.sortedSources.length - 1) {
        self.setActiveSource(self.sortedSources[nextIndex])
        return nextIndex
      }
      return -1
    },
    setFilter(value) {
      self.filter = value
    },
    setMode(mode) {
      self.mode = mode
    },
    addSource(source) {
      self.sources.put(source)
    },
    removeSource(source) {
      if (self.activeSource === source) {
        self.setActiveSource(null)
      }
      destroy(source)
    },
    clearItems() {
      if (self.activeSource) {
        self.activeSource.clearItems()
      } else {
        self.allSources.forEach((x) => x.clearItems())
      }
    },
    fetchSources() {
      self.sortedSources.forEach((source) => {
        source.setStatus("pending")
      })
    },
    importOPML(path) {
      const sources = parseOPML(path)

      sources.forEach((source) => {
        try {
          self.addSource(source)
        } catch (err) {
          console.warn(err)
        }
      })
    },
  }))
