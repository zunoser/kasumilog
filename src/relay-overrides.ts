export interface RelayOperationOverride {
  readonly queryId: string;
  readonly features: Readonly<Record<string, boolean>>;
  readonly variables?: Readonly<Record<string, unknown>>;
}

const timelineFeatures = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
} as const;

const memberMutationFeatures = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
} as const;

export const RELAY_REQUEST_OVERRIDE_SET = {
  capturedAt: "2026-08-18",
  operations: {
    ListLatestTweetsTimeline: {
      queryId: "1LE3u14FJjPZUHKFGzos2g",
      features: timelineFeatures,
      variables: { count: 20 },
    },
    ListMembers: {
      queryId: "8rYmkvWQe9jRRZdy_-vkGA",
      features: timelineFeatures,
      variables: { count: 20 },
    },
    ListAddMember: {
      queryId: "V2yIKI9d6o_9D9rJ9-a-2w",
      features: memberMutationFeatures,
    },
    ListRemoveMember: {
      queryId: "NYsw9xBA6rSMA3N5sccSJA",
      features: memberMutationFeatures,
    },
  } satisfies Readonly<Record<string, RelayOperationOverride>>,
} as const;

export function hasReviewedRelayOverride(operation: string): boolean {
  return Object.hasOwn(RELAY_REQUEST_OVERRIDE_SET.operations, operation);
}
