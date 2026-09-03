/**
 * Height of one audio automation lane.
 *
 * Its own module because both the row layout and the lane itself need it, and
 * putting it in either would have the layout importing a component or the
 * component's constant living somewhere it is not used.
 *
 * Automation remains a full editable envelope lane. Applied effects and color
 * treatment use their own thin strips inside the owning media clip.
 */
export const AUTOMATION_LANE_H = 72;
