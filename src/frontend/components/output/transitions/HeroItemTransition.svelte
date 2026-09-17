<script lang="ts">
    // "Hero" transition: morphs an item into its matched counterpart on the next slide (position/size/etc.)
    // instead of cross-fading. The same Textbox instance is kept mounted across the slide change, and a
    // temporary CSS "transition" rule is applied to its style so the browser interpolates the change natively.
    import type { Item, Transition } from "../../../../types/Show"
    import { cssEasing } from "../../../utils/transitions"
    import Textbox from "../../slide/Textbox.svelte"

    export let item: Item
    export let heroTransition: Transition | undefined = undefined

    export let backdropFilter = ""
    export let chords = false
    export let animationStyle: any = {}
    export let ratio = 1
    export let outputId = ""
    export let ref: any
    export let linesStart: null | number = null
    export let linesEnd: null | number = null
    export let clickRevealed = false
    export let outputStyle: any = null
    export let mirror = false
    export let preview = false
    export let slideIndex = 0
    export let styleIdOverride = ""
    export let autoSizeKey = ""
    export let updateDynamicValues = true

    let transitionStyle = ""
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    let initialized = false

    $: if (item) startMorph()
    function startMorph() {
        // the very first render has nothing to morph from (the node is being created now) - a transition rule here would
        // only animate the late style/auto size updates that land right after mount, so wait for an actual item change
        if (!initialized) {
            initialized = true
            return
        }

        const duration = heroTransition?.type === "none" ? 0 : (heroTransition?.duration ?? 500)

        if (clearTimer) clearTimeout(clearTimer)

        if (!duration) {
            transitionStyle = ""
            return
        }

        const easing = cssEasing(heroTransition?.easing)
        transitionStyle = `transition: all ${duration}ms ${easing};`

        // remove the transition rule once done, so later (unrelated) style updates don't animate
        clearTimer = setTimeout(() => {
            transitionStyle = ""
        }, duration + 50)
    }
</script>

<Textbox
    {item}
    {transitionStyle}
    {backdropFilter}
    {chords}
    {animationStyle}
    {ratio}
    {outputId}
    {ref}
    {linesStart}
    {linesEnd}
    {clickRevealed}
    {outputStyle}
    {mirror}
    {preview}
    {slideIndex}
    {styleIdOverride}
    {autoSizeKey}
    {updateDynamicValues}
/>
