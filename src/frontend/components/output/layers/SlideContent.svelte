<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import type { Item, OutSlide, SlideData, TimelineAction, Transition } from "../../../../types/Show"
    import { scriptureSettings, showsCache, slideTimelineSpeedMultiplier, templates } from "../../../stores"
    import { waitUntilValueIsDefined } from "../../../utils/common"
    import { shouldItemBeShown } from "../../edit/scripts/itemHelpers"
    import { getItemText } from "../../edit/scripts/textStyle"
    import { clone } from "../../helpers/array"
    import { loadCustomFonts } from "../../helpers/fonts"
    import { getStyleTemplate, itemNeedsAutoSize, slideHasAutoSizeItem } from "../../helpers/output"
    import Textbox from "../../slide/Textbox.svelte"
    import { SlideTimeline } from "../../timeline/SlideTimeline"
    import HeroItemTransition from "../transitions/HeroItemTransition.svelte"
    import OutputTransition from "../transitions/OutputTransition.svelte"
    import SlideItemTransition from "../transitions/SlideItemTransition.svelte"

    export let outputId: string
    export let outSlide: OutSlide
    export let isClearing = false

    export let slideData: SlideData | null
    export let currentSlide: any // Slide | null
    export let currentStyle: any

    export let animationData: any
    export let currentLineId: string | undefined
    export let lines: any

    export let ratio: number
    export let mirror = false
    export let preview = false
    export let transition: any = {}
    export let transitionEnabled = false
    export let styleIdOverride = ""

    let origin = ""
    $: if (outSlide.id) updateShow()
    function updateShow() {
        // custom fonts
        const currentShow = $showsCache[outSlide.id]
        loadCustomFonts(currentShow?.settings?.customFonts || [])
        origin = currentShow?.origin || ""
    }

    // TEST:
    // conditions
    // transitions
    // overlays
    // style lines
    // starting slide while clearing

    let currentItems: Item[] = []
    let current: any = {}
    let show = false

    // Track items that are unchanged between slides and have no transition (to avoid redraw flicker)
    let persistentItems: Item[] = []
    let persistentItemIndexes: number[] = []

    // Hero items morph into their matched counterpart instead of cross-fading.
    // Rendered via a separate keyed block (keyed by content signature, not array index - items commonly
    // shift position between slides, e.g. another item gets added/removed before it) so the same DOM node
    // (and therefore its CSS "morph" transition) survives across the slide change regardless of position.
    let heroItemIndexes: number[] = []
    let heroMorphs: { [signature: string]: { item: Item; heroTransition: Transition; index: number } } = {}

    // Check if an item has lines/text content
    function hasLinesContent(item: Item | undefined): boolean {
        if (!item) return false
        return !!getItemText(item).length
    }

    // Compare two items to see if their visible content is identical
    function itemsAreEqual(oldItem: Item | undefined, newItem: Item | undefined): boolean {
        if (!oldItem || !newItem) return false
        // Compare the full serialized content (lines, style, etc.)
        return JSON.stringify(oldItem) === JSON.stringify(newItem)
    }

    // "same item" heuristic for the hero transition - matched on content identity, not position
    // (position/size is exactly what's expected to differ, that's what gets morphed).
    // Returns "" when the item has no reliable identity to match on (e.g. empty text box).
    function getItemSignature(item: Item | undefined): string {
        if (!item) return ""
        const type = item.type || "text"
        if (type === "text") {
            const text = getItemText(item).trim()
            return text ? "text:" + text : ""
        }
        // media/image/video/etc - match by source
        const src = item.src || item.media?.id || ""
        return src ? "media:" + src : ""
    }

    // find the "hero" transition to use, checking the specific in/out/between overrides (a real transition can have
    // its type set on one of these sub-objects instead of the top level, when "specific transitions" is enabled)
    function getHeroTransition(transition: Transition | undefined): Transition | null {
        if (!transition) return null
        if (transition.between?.type === "hero") return transition.between
        if (transition.in?.type === "hero") return transition.in
        if (transition.out?.type === "hero") return transition.out
        if (transition.type === "hero") return transition
        return null
    }
    // maintain a hidden workload that primes autosize results ahead of the visible reveal
    let precomputeTargets: { item: Item; index: number; key: string }[] = []
    let precomputePending = new Set<string>()

    const showItemRef = { outputId, slideIndex: outSlide?.index }
    let conditionsUpdater = 0
    let isMic = false
    $: isMic = JSON.stringify(currentItems.map((a) => a?.conditions) || "").includes('"element":"volume"')

    let updaterInterval: NodeJS.Timeout
    $: {
        clearInterval(updaterInterval)
        updaterInterval = setInterval(
            () => {
                if (isClearing || !Array.isArray(currentItems)) return
                if (currentItems.find((a) => a?.conditions)) conditionsUpdater++
            },
            isMic ? 100 : 300
        )
    }
    onDestroy(() => clearInterval(updaterInterval))

    // do not update if only line has changed
    $: currentOutSlide = "{}"
    $: if (outSlide) {
        let newOutSlide = clone(outSlide)
        delete newOutSlide.line
        delete newOutSlide.revealCount
        delete newOutSlide.itemClickReveal
        let outSlideString = JSON.stringify(newOutSlide)
        if (outSlideString !== currentOutSlide) currentOutSlide = outSlideString
    }
    // do not update if lines has no changes for this output
    $: currentLines = "{}"
    $: if (lines) {
        let outLinesString = JSON.stringify(lines)
        if (outLinesString !== currentLines) currentLines = outLinesString
    }
    // only update if changed (no update when another output changes)
    let currentSlideItems: Item[] | null = null
    $: if (currentSlide?.items !== 0) {
        if (JSON.stringify(currentSlide?.items) !== JSON.stringify(currentSlideItems)) currentSlideItems = clone(currentSlide?.items || null)
    }
    $: if (current && outSlide) {
        if (current.outSlide && current.outSlide.id === outSlide.id && current.outSlide.index === outSlide.index) {
            current.outSlide.itemClickReveal = outSlide.itemClickReveal
            current.outSlide.revealCount = outSlide.revealCount
            current.outSlide.line = outSlide.line
        }
    }
    $: if (current && lines) {
        current.lines = clone(lines)
    }

    $: if (currentSlideItems !== undefined || currentOutSlide || currentLines) updateItems()
    let timeout: NodeJS.Timeout | null = null
    let updateGeneration = 0

    // if anything is outputted & changing to something that's outputted
    let transitioningBetween = false

    let onPrecomputeDone: (() => void) | null = null

    // kick off hidden textbox renders that warm the autosize cache before we flip "show" on
    function scheduleAutoSizePrecompute(items: Item[]) {
        onPrecomputeDone = null
        if (preview || !Array.isArray(items) || !items.length) {
            precomputeTargets = []
            precomputePending.clear()
            return
        }

        const targets: { item: Item; index: number; key: string }[] = []
        const pendingKeys = new Set<string>()

        items.forEach((item, index) => {
            if (!itemNeedsAutoSize(item)) return
            const key = createAutoSizeKey(item, index)
            if (!key) return
            if (item.autoFontSize) return // skip entries that already have cached measurements

            pendingKeys.add(key)
            targets.push({ item: clone(item), index, key })
        })

        precomputeTargets = targets
        precomputePending = pendingKeys
    }

    // remove hidden probes once the underlying textbox reports that its autosize cache is hot
    function handlePrecomputeReady(event: CustomEvent<{ key: string; fontSize: number }>) {
        const key = event.detail?.key
        if (!key || !precomputePending.has(key)) return
        precomputePending.delete(key)
        if (!precomputePending.size) {
            precomputeTargets = []
            onPrecomputeDone?.()
            onPrecomputeDone = null
        }
    }

    // create a stable identifier for precompute + visible textbox coordination
    function createAutoSizeKey(item: Item, index: number) {
        return item?.id ? String(item.id) : `idx-${index}`
    }

    // outgoing items hold for auto size delay while incoming content calculates font size
    $: incomingNeedsAutoSize = slideNeedsAutoSize(currentSlide, outSlide, currentStyle)
    function slideNeedsAutoSize(slide: any, out: OutSlide, style: any) {
        if (slide?.items?.some(itemNeedsAutoSize)) return true

        let customTemplate = getStyleTemplate(out, style)
        if (!Object.keys(customTemplate).length && out?.id === "temp") customTemplate = $templates[$scriptureSettings.template] || {}

        return slideHasAutoSizeItem(customTemplate)
    }

    let isClearingToEmpty = false
    async function updateItems() {
        let betweenClearingTransition = transition.between || transition
        if (betweenClearingTransition?.type === "none") betweenClearingTransition.duration = 0

        if (!currentSlideItems?.length) {
            scheduleAutoSizePrecompute([])
            currentItems = []
            // Clear persistent/hero items when no slide content
            persistentItems = []
            persistentItemIndexes = []
            heroItemIndexes = []
            heroMorphs = {}
            current = {
                outSlide: clone(outSlide),
                slideData: clone(slideData),
                currentSlide: clone(currentSlide),
                lines: clone(lines),
                currentStyle: clone(currentStyle)
            }

            // wait for items to properly clear
            // if changing quickly from text to empty to text again, the first text will be displayed again (due to Svelte transition bug)
            if (transitionEnabled) {
                isClearingToEmpty = true
                setTimeout(() => (isClearingToEmpty = false), betweenClearingTransition.duration)
            }
            return
        }

        if (isClearingToEmpty) await waitUntilValueIsDefined(() => !isClearingToEmpty, 10, betweenClearingTransition.duration)

        scheduleAutoSizePrecompute(currentSlide.items)

        // get any items with no transition between the two slides
        let oldItemTransition = currentItems.find((a) => a.actions?.transition)?.actions?.transition
        let newItemTransition = currentSlide.items.find((a) => a.actions?.transition)?.actions?.transition
        let itemTransitionDuration: number | null = null
        if (oldItemTransition && JSON.stringify(oldItemTransition) === JSON.stringify(newItemTransition)) {
            itemTransitionDuration = oldItemTransition.duration ?? null
            if (oldItemTransition.type === "none") itemTransitionDuration = 0
            // find any item that should have no transition!
            else if (currentSlide.items.find((a) => a.actions?.transition?.duration === 0 || a.actions?.transition?.type === "none")) itemTransitionDuration = 0
        }

        let currentTransition = transition.between || transition.in || transition
        if (currentTransition?.type === "none") currentTransition.duration = 0

        let currentTransitionDuration = transitionEnabled ? (itemTransitionDuration ?? currentTransition?.duration ?? 0) : 0
        let waitToShow = currentTransitionDuration * ((currentTransition?.fadeInOffset ?? 50) / 100)

        // Identify items that are unchanged and have no lines content (to keep outputted without fade)
        const newPersistentIndexes: number[] = []
        const newPersistentItems: Item[] = []
        const transitioningItems: Item[] = []
        const transitioningIndexes: number[] = []
        const newHeroIndexes: number[] = []
        const newHeroMorphs: { [signature: string]: { item: Item; heroTransition: Transition; index: number } } = {}

        // index in the old/new item list on a slide doesn't correspond to the "same" item across slides
        // (items get added/removed/reordered) - so hero matching is by content signature, not position
        const oldItemsBySignature = new Map<string, Item>()
        currentItems.forEach((item) => {
            const signature = getItemSignature(item)
            if (signature) oldItemsBySignature.set(signature, item)
        })

        currentSlide.items.forEach((newItem: Item, newIndex: number) => {
            // Find matching old item by index (position-based matching for slides)
            const oldItem = currentItems[newIndex]

            // Hero: morph into a matching item instead of cross-fading, when a match is found on the previous slide.
            // Falls back to a normal (fade) transition below when there's no matching item.
            // Either end of the transition can carry the "hero" tag - the item leaving the old slide, or the item arriving on the new one -
            // and it can be set on the base type or on one of the in/out/between overrides.
            const signature = getItemSignature(newItem)
            const matchedOldItem = signature ? oldItemsBySignature.get(signature) : undefined
            const newHeroTransition = getHeroTransition(newItem.actions?.transition || currentTransition)
            const oldHeroTransition = getHeroTransition(matchedOldItem?.actions?.transition)
            // Route every hero enabled item through the keyed hero block, also when there's no match on the previous slide.
            // The morph interpolates an existing DOM node, so that node has to already be mounted (at the old position)
            // when the slide changes. Only joining the block once a match appeared meant the first change created the node
            // from scratch at its new position - nothing to interpolate from, so it cut, and only morphed from the second
            // transition onwards. Without a match the item just mounts/unmounts with the regular fade (see markup below).
            // Duplicate signatures (two identical items on one slide) can't be keyed apart - the extra one falls through.
            if (transitionEnabled && signature && !newHeroMorphs[signature] && (newHeroTransition || oldHeroTransition)) {
                newHeroIndexes.push(newIndex)
                newHeroMorphs[signature] = { item: clone(newItem), heroTransition: (newHeroTransition || oldHeroTransition) as Transition, index: newIndex }
                return
            }

            // Item is persistent if:
            // 1. Content is unchanged AND
            // 2. It does not have lines/text content (non-text items or text items without lines content)
            if (!hasLinesContent(newItem) && itemsAreEqual(oldItem, newItem)) {
                newPersistentIndexes.push(newIndex)
                newPersistentItems.push(clone(newItem))
            } else {
                // Item needs to be re-rendered (changed, or has lines content)
                transitioningIndexes.push(newIndex)
                transitioningItems.push(clone(newItem))
            }
        })

        // Update persistent items (these won't flash)
        persistentItemIndexes = newPersistentIndexes
        persistentItems = newPersistentItems

        // Update hero items (these morph via a native CSS transition instead of cross-fading)
        heroItemIndexes = newHeroIndexes
        heroMorphs = newHeroMorphs

        // between
        const isDifferentSlide = current.currentSlide?.id !== currentSlide?.id || current.outSlide?.index !== outSlide?.index || current.outSlide?.id !== outSlide?.id
        if (isDifferentSlide && currentItems.length && currentSlide.items.length) transitioningBetween = true

        if (timeout) clearTimeout(timeout)

        // If all items are persistent (unchanged), skip the show/hide cycle entirely
        if (transitioningItems.length === 0 && persistentItems.length > 0) {
            // Just update the context without triggering transitions
            current = {
                outSlide: clone(outSlide),
                slideData: clone(slideData),
                currentSlide: clone(currentSlide),
                lines: clone(lines),
                currentStyle: clone(currentStyle)
            }
            // Keep currentItems in sync but don't toggle show
            currentItems = clone(currentSlide.items || [])
            transitioningBetween = false
            return
        }

        const gen = ++updateGeneration

        // wait for between to update out transition
        timeout = setTimeout(() => {
            if (gen !== updateGeneration) return
            show = false

            // wait for previous items to start fading out (svelte will keep them until the transition is done!)
            timeout = setTimeout(() => {
                if (gen !== updateGeneration) return
                // Only include items that need transitioning in currentItems
                // Persistent items are rendered separately
                currentItems = clone(currentSlide.items || [])
                current = {
                    outSlide: clone(outSlide),
                    slideData: clone(slideData),
                    currentSlide: clone(currentSlide),
                    lines: clone(lines),
                    currentStyle: clone(currentStyle)
                }

                // wait until half transition duration of previous items have passed as it looks better visually
                timeout = setTimeout(() => {
                    if (gen !== updateGeneration) return

                    const showSlide = () => {
                        if (gen !== updateGeneration) return
                        show = true

                        // wait for between to set in transition
                        timeout = setTimeout(() => {
                            if (gen !== updateGeneration) return
                            transitioningBetween = false
                        })
                    }

                    if (precomputePending.size) {
                        const safetyTimer = setTimeout(showSlide, 150)
                        onPrecomputeDone = () => {
                            clearTimeout(safetyTimer)
                            showSlide()
                        }
                    } else {
                        showSlide()
                    }
                }, waitToShow)
            })
        })
    }

    // OUTPUT SLIDE TIMELINE
    // get current slide timeline position
    let timelinePos = 0
    let timelineItems = new Map<string, Item[]>()
    let timelineActions: TimelineAction[] = []
    let isReady = false
    $: if (outSlide) isReady = false
    $: if (currentSlide) setupTimeline()
    function setupTimeline() {
        if (isReady) return
        timelinePos = 0
        timelineActions = currentSlide?.timeline?.actions || []
        // timelineItems = new Set<Item[]>() // WIP reset eventually?
        setTimeout(() => (isReady = true))
    }
    onMount(() => {
        const interval = setInterval(() => {
            if (isClearing || !isReady || !timelineActions.length) return
            // WIP use actual slide timeline pos when available?
            timelinePos += 15 * $slideTimelineSpeedMultiplier
            styleActions(timelineActions)

            // loop back when reached last action
            if (currentSlide?.timeline?.loop) {
                const lastActionTime = Math.max(...timelineActions.map((a) => a.time + (a.duration || 0) * 1000))
                if (timelinePos >= lastActionTime) timelinePos = 0
            }
        }, 15)

        function styleActions(actions: TimelineAction[]) {
            const itemStyleActions = actions.filter((a) => a.type === "style")
            // group by style key & indexes
            const groupedActions = new Map<string, TimelineAction[]>()
            for (const action of itemStyleActions) {
                const key = action.data?.key
                if (!key) continue

                const indexes = action.data?.indexes ? action.data.indexes.join(",") : ""
                const groupKey = `${key}-${indexes}`

                if (!groupedActions.has(groupKey)) groupedActions.set(groupKey, [])
                groupedActions.get(groupKey)?.push(action)
            }

            const slideKey = `${outSlide?.id}-${outSlide?.layout}-${outSlide?.index}`
            const items = clone(timelineItems.get(slideKey) || currentItems)

            const currentTime = timelinePos
            groupedActions.forEach((actions, _key) => {
                const previous = getPreviousAction(actions)
                const next = getNextAction(actions)
                const value = SlideTimeline.interpolateValue(previous, next, currentTime)
                if (value === null) return

                const action = (previous || next)!
                // const ref = _show(outSlide?.id || "").layouts([outSlide?.layout]).ref()[0] || []
                // const slideId = ref[outSlide?.index || 0]?.id
                // SlideTimeline.triggerAction(action, value, { id: outSlide.id, slideId: slideId })

                const itemIndexes = action.data.indexes ?? [0]
                itemIndexes.forEach((itemIndex) => {
                    const item = items[itemIndex]
                    if (!item) return

                    const updatedItem = SlideTimeline.updateStyle(action, item, value)
                    items[itemIndex] = updatedItem
                })
            })

            timelineItems.set(slideKey, items)
            timelineItems = timelineItems
        }

        function getPreviousAction(actions: TimelineAction[]) {
            const now = timelinePos
            return actions.reduce((prev, curr) => (curr.time > (prev?.time ?? -1) && curr.time <= now ? curr : prev), null as TimelineAction | null)
        }

        function getNextAction(actions: TimelineAction[]) {
            const now = timelinePos
            return actions.reduce((next, curr) => (curr.time > now && (next === null || curr.time < next.time) ? curr : next), null as TimelineAction | null)
        }

        return () => {
            clearInterval(interval)
        }
    })
</script>

<!-- Render all items in original order to maintain z-index layering -->
{#each currentItems as item, index}
    {#if item && shouldItemBeShown(item, [], showItemRef, conditionsUpdater) && (!item.clickReveal || current.outSlide?.itemClickReveal)}
        {#if persistentItemIndexes.includes(index)}
            <!-- Persistent item: unchanged content, render outside transition to avoid flicker -->
            <Textbox
                backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                chords={item.chords?.enabled}
                animationStyle={animationData.style || {}}
                item={timelineItems.get(`${current.outSlide?.id}-${current.outSlide?.layout}-${current.outSlide?.index}`)?.[index] || item}
                transition={null}
                {ratio}
                {outputId}
                ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout, origin }}
                linesStart={current.lines?.[currentLineId || ""]?.[item.lineReveal ? "linesStart" : "start"]}
                linesEnd={current.lines?.[currentLineId || ""]?.[item.lineReveal ? "linesEnd" : "end"]}
                clickRevealed={!!current.lines?.[currentLineId || ""]?.clickRevealed}
                outputStyle={current.currentStyle}
                {mirror}
                {preview}
                slideIndex={current.outSlide?.index}
                {styleIdOverride}
                autoSizeKey={createAutoSizeKey(item, index)}
                updateDynamicValues={!isClearing}
            />
        {:else if heroItemIndexes.includes(index)}
            <!-- Hero item: rendered below in a signature-keyed block instead, so its DOM node survives moving to a different index -->
        {:else}
            <!-- Transitioning item: render with animation wrapper inside {#key} -->
            {#key show}
                {#if show}
                    <SlideItemTransition {preview} {transitionEnabled} {transitioningBetween} {isClearing} {incomingNeedsAutoSize} globalTransition={transition} currentSlide={current.currentSlide} {item} outSlide={current.outSlide} lines={current.lines} currentStyle={current.currentStyle} let:customSlide let:customItem let:customLines let:customOut let:transition>
                        <Textbox
                            backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                            chords={customItem.chords?.enabled}
                            animationStyle={animationData.style || {}}
                            item={timelineItems.get(`${customOut?.id}-${customOut?.layout}-${customOut?.index}`)?.[index] || customItem}
                            {transition}
                            {ratio}
                            {outputId}
                            ref={{ type: "show", showId: customOut?.id, slideId: customSlide?.id, id: customSlide?.id || "", layoutId: customOut?.layout, origin }}
                            linesStart={customLines?.[currentLineId || ""]?.[item.lineReveal ? "linesStart" : "start"]}
                            linesEnd={customLines?.[currentLineId || ""]?.[item.lineReveal ? "linesEnd" : "end"]}
                            clickRevealed={!!customLines?.[currentLineId || ""]?.clickRevealed}
                            outputStyle={current.currentStyle}
                            {mirror}
                            {preview}
                            slideIndex={customOut?.index}
                            {styleIdOverride}
                            autoSizeKey={createAutoSizeKey(item, index)}
                            updateDynamicValues={!isClearing}
                        />
                    </SlideItemTransition>
                {/if}
            {/key}
        {/if}
    {/if}
{/each}

<!-- Hero items: keyed by content signature (not array index) so the DOM node persists across the slide change even if the item's position shifts.
     A persisting node morphs (no in/out runs on it); one without a counterpart on the other slide fades in/out like a normal item. -->
{#each Object.entries(heroMorphs) as [signature, morph] (signature)}
    {#if shouldItemBeShown(morph.item, [], showItemRef, conditionsUpdater) && (!morph.item.clickReveal || current.outSlide?.itemClickReveal)}
        <OutputTransition inTransition={morph.heroTransition} outTransition={morph.heroTransition}>
            <HeroItemTransition
                backdropFilter={current.slideData?.["backdrop-filter"] || ""}
                chords={morph.item.chords?.enabled}
                animationStyle={animationData.style || {}}
                item={timelineItems.get(`${current.outSlide?.id}-${current.outSlide?.layout}-${current.outSlide?.index}`)?.[morph.index] || morph.item}
                heroTransition={morph.heroTransition}
                {ratio}
                {outputId}
                ref={{ type: "show", showId: current.outSlide?.id, slideId: current.currentSlide?.id, id: current.currentSlide?.id || "", layoutId: current.outSlide?.layout }}
                linesStart={current.lines?.[currentLineId || ""]?.[morph.item.lineReveal ? "linesStart" : "start"]}
                linesEnd={current.lines?.[currentLineId || ""]?.[morph.item.lineReveal ? "linesEnd" : "end"]}
                clickRevealed={!!current.lines?.[currentLineId || ""]?.clickRevealed}
                outputStyle={current.currentStyle}
                {mirror}
                {preview}
                slideIndex={current.outSlide?.index}
                {styleIdOverride}
                autoSizeKey={createAutoSizeKey(morph.item, morph.index)}
                updateDynamicValues={!isClearing}
            />
        </OutputTransition>
    {/if}
{/each}

{#if precomputeTargets.length}
    <div class="autosize-precompute" aria-hidden="true">
        {#each precomputeTargets as target (target.key)}
            <Textbox item={target.item} {ratio} {outputId} outputStyle={currentStyle} {mirror} {preview} {styleIdOverride} ref={{ type: "show", showId: outSlide?.id, slideId: currentSlide?.id, id: currentSlide?.id || "", layoutId: outSlide?.layout }} autoSizeKey={target.key} on:autosizeReady={handlePrecomputeReady} updateDynamicValues={!isClearing} />
        {/each}
    </div>
{/if}

<style>
    /* park precompute textboxes far off-screen so they never flash during transitions */
    .autosize-precompute {
        position: absolute;
        top: -10000px;
        left: -10000px;
        width: 0;
        height: 0;
        overflow: hidden;
        pointer-events: none;
        visibility: hidden;
    }
</style>
