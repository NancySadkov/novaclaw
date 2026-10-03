import type { DatabaseMigration } from "./migration"
import migration_0 from "./migration/20260127222353_familiar_lady_ursula"
import migration_1 from "./migration/20260211171708_add_project_commands"
import migration_2 from "./migration/20260213144116_wakeful_the_professor"
import migration_3 from "./migration/20260225215848_workspace"
import migration_4 from "./migration/20260227213759_add_session_workspace_id"
import migration_5 from "./migration/20260228203230_blue_harpoon"
import migration_6 from "./migration/20260303231226_add_workspace_fields"
import migration_7 from "./migration/20260309230000_move_org_to_state"
import migration_8 from "./migration/20260312043431_session_message_cursor"
import migration_9 from "./migration/20260323234822_events"
import migration_10 from "./migration/20260410174513_workspace-name"
import migration_11 from "./migration/20260413175956_chief_energizer"
import migration_12 from "./migration/20260423070820_add_icon_url_override"
import migration_13 from "./migration/20260427172553_slow_nightmare"
import migration_14 from "./migration/20260428004200_add_session_path"
import migration_15 from "./migration/20260501142318_next_venus"
import migration_16 from "./migration/20260504145000_add_sync_owner"
import migration_17 from "./migration/20260507164347_add_workspace_time"
import migration_18 from "./migration/20260510033149_session_usage"
import migration_19 from "./migration/20260511000411_data_migration_state"
import migration_20 from "./migration/20260511173437_session-metadata"
import migration_21 from "./migration/20260601010001_normalize_storage_paths"
import migration_22 from "./migration/20260601202201_amazing_prowler"
import migration_23 from "./migration/20260602002951_lowly_union_jack"
import migration_24 from "./migration/20260602182828_add_project_directories"
import migration_25 from "./migration/20260603001617_session_message_projection_indexes"
import migration_26 from "./migration/20260603040000_session_message_projection_order"
import migration_27 from "./migration/20260603141458_session_input_inbox"
import migration_28 from "./migration/20260603160727_jittery_ezekiel_stane"
import migration_29 from "./migration/20260604172448_event_sourced_session_input"
import migration_30 from "./migration/20260605003541_add_session_context_snapshot"
import migration_31 from "./migration/20260605042240_add_context_epoch_agent"
import migration_32 from "./migration/20260611035744_credential"
import migration_33 from "./migration/20260611192811_lush_chimera"
import migration_34 from "./migration/20260612174303_project_dir_strategy"
import migration_35 from "./migration/20260622142730_simplify_session_context_epoch"
import migration_36 from "./migration/20260622170816_reset_v2_session_state"
import migration_37 from "./migration/20260622202450_simplify_session_input"
import migration_38 from "./migration/20260701104807_add_session_system_prompt_override"
import migration_39 from "./migration/20260701131350_add_session_result"
import migration_40 from "./migration/20260702210000_add_session_type_priority"
import migration_41 from "./migration/20260702230000_add_permission_mode_and_saved_effect"
import migration_42 from "./migration/20260703120000_add_kb_fact"
import migration_43 from "./migration/20260703140000_add_session_responder"
import migration_44 from "./migration/20260705120000_add_catalog"
import migration_45 from "./migration/20260706220000_add_session_tag"
import migration_46 from "./migration/20260708000000_drop_legacy_message_part"
import migration_47 from "./migration/20260709120000_add_jh_plan"
import migration_48 from "./migration/20260714090000_add_session_strict"
import migration_49 from "./migration/20260714110806_add_session_features"
import migration_50 from "./migration/20260714140121_add_agent_config"
import migration_51 from "./migration/20260714141710_add_command_config"
import migration_52 from "./migration/20260714213000_add_skill_reference_config"
import migration_53 from "./migration/20260715090000_add_plugin_config"
import migration_54 from "./migration/20260715100000_add_runtime_setting"
import migration_55 from "./migration/20260717120000_permission_origin"
import migration_56 from "./migration/20260717130000_workspace_origin"
import migration_57 from "./migration/20260717150000_drop_project_entity"
import migration_58 from "./migration/20260717160000_add_bash_job"
import migration_59 from "./migration/20260718150000_drop_kb_fact"
import migration_60 from "./migration/20260720120000_drop_kb_vec_leftovers"
import migration_61 from "./migration/20260721190000_add_instance_identity"
import migration_62 from "./migration/20260722135926_add_messenger"
import migration_63 from "./migration/20260724120000_add_calendar"
import migration_64 from "./migration/20260725120000_add_calendar_permission"
import migration_65 from "./migration/20260725140000_add_web_host_budget"
import migration_66 from "./migration/20260725160000_add_session_thinking_budget"
import migration_67 from "./migration/20260725170000_add_session_edit_switches"
import migration_68 from "./migration/20260728181001_add_jh_plan_time_updated_index"
import migration_69 from "./migration/20260730201959_add_messenger_source_access"
import migration_70 from "./migration/20260730221834_add_session_safe_mode"
import migration_71 from "./migration/20260731023939_add_messenger_initiation_budget"
import migration_72 from "./migration/20260801043513_add_session_context_budget"
import migration_73 from "./migration/20260801060145_add_session_compaction_overlay"
import migration_74 from "./migration/20260801085049_add_tool_catalogue"
import migration_75 from "./migration/20260802165703_add_session_provider_recovery"
import migration_76 from "./migration/20260802232319_session_changes_revision"
import migration_77 from "./migration/20260803223916_session_execution_lease"
import migration_78 from "./migration/20260803230202_execution_provider_recovery"
import migration_79 from "./migration/20260804164548_stormy_skreet"
import migration_80 from "./migration/20260807173556_add_session_device"
import migration_81 from "./migration/20260808122357_add_session_auto_grant"
import migration_82 from "./migration/20260808131913_add_session_component_registry"
import migration_83 from "./migration/20260808152334_add_session_control_binding"
import migration_84 from "./migration/20260808210101_durable_permission_ask"
import migration_85 from "./migration/20260810005722_add_session_memory"
import migration_86 from "./migration/20260810014020_add_session_short_chat"
import migration_87 from "./migration/20260812165955_add_session_quality_check"
import migration_88 from "./migration/20260813001757_add_todo_snapshot"
import migration_89 from "./migration/20260813224857_add_session_execution_served_by"
import migration_90 from "./migration/20260814172542_add_instance_identity_keypair"
import migration_91 from "./migration/20260814182155_add_community_contact"
import migration_92 from "./migration/20260814183208_add_community_channel"
import migration_93 from "./migration/20260815003907_add_community_message_nonce"
import migration_94 from "./migration/20260815004815_contact_successor"
import migration_95 from "./migration/20260815041249_add_community_peer"
import migration_96 from "./migration/20260815050952_add_channel_listed"
import migration_97 from "./migration/20260815054456_add_community_succession"
import migration_98 from "./migration/20260815070119_add_sealing_key"
import migration_99 from "./migration/20260815072143_add_direct_message"
import migration_100 from "./migration/20260815084652_add_community_offer"
import migration_101 from "./migration/20260815105906_add_community_filter"
import migration_102 from "./migration/20260816191116_add_community_observation"
import migration_103 from "./migration/20260816201827_add_peer_introducer"
import migration_104 from "./migration/20260816204530_add_community_answered"
import migration_105 from "./migration/20260816215708_add_contact_trust"
import migration_106 from "./migration/20260817222746_add_succession_cosignature"
import migration_107 from "./migration/20260818192520_add_session_policy_decision"
import migration_108 from "./migration/20260819032112_drop_plugin_config"
import migration_109 from "./migration/20260821035115_add_agent_token_minute"
import migration_110 from "./migration/20260821070238_add_session_compaction_request"
import migration_111 from "./migration/20260824180000_collapse_duplicate_colleague_chats"
import migration_112 from "./migration/20260824205121_amusing_invaders"
import migration_113 from "./migration/20260825081039_add_session_memory_cleanup"
import migration_114 from "./migration/20260825170018_strange_gorilla_man"
import migration_115 from "./migration/20260828035956_heavy_omega_red"
import migration_116 from "./migration/20260828125640_lumpy_paladin"
import migration_117 from "./migration/20260901051852_crazy_sheva_callister"
import migration_118 from "./migration/20260904004405_drop_inert_session_permission"
import migration_119 from "./migration/20260905030820_dry_energizer"
import migration_120 from "./migration/20260905090000_bound_calendar_fire_history"
import migration_121 from "./migration/20260905110000_calendar_fire_outcome"
import migration_122 from "./migration/20260908181923_add_session_nudge_delivery"
import migration_123 from "./migration/20260914015547_model_prefix_cache"
import migration_124 from "./migration/20260917133451_smiling_red_ghost"
import migration_125 from "./migration/20260917192630_wealthy_triton"
import migration_126 from "./migration/20260918014107_drop_calendar_overrides"
import migration_127 from "./migration/20260918045440_drop_permission_table"
import migration_128 from "./migration/20260923161501_late_wendell_vaughn"
import migration_129 from "./migration/20260923190000_agent_schedule"
import migration_130 from "./migration/20260923220841_messenger_agent_owner"
import migration_131 from "./migration/20260924120000_retire_auto_prompting"
import migration_132 from "./migration/20260924180000_portable_instance_paths"
import migration_133 from "./migration/20260925165054_agent_retirement_ledger"
import migration_134 from "./migration/20260927201500_retire_the_anonymous_agents"
import migration_135 from "./migration/20260927214353_add_scratch_horizon"
import migration_136 from "./migration/20260927225632_work_projects"
import migration_137 from "./migration/20260928002558_work_project_directory"
import migration_138 from "./migration/20260928093000_colleague_is_always_reachable"
import migration_139 from "./migration/20260928140000_owner_inbox"
import migration_140 from "./migration/20260930002633_recipe_projects"
import migration_141 from "./migration/20260930013142_project_kickoff_delivery"
import migration_142 from "./migration/20260930100000_retire_internal_roles"
import migration_143 from "./migration/20261001120000_artist_imagemagick_job"
import migration_144 from "./migration/20261003035715_windy_proudstar"

export const migrations = [
  migration_0,
  migration_1,
  migration_2,
  migration_3,
  migration_4,
  migration_5,
  migration_6,
  migration_7,
  migration_8,
  migration_9,
  migration_10,
  migration_11,
  migration_12,
  migration_13,
  migration_14,
  migration_15,
  migration_16,
  migration_17,
  migration_18,
  migration_19,
  migration_20,
  migration_21,
  migration_22,
  migration_23,
  migration_24,
  migration_25,
  migration_26,
  migration_27,
  migration_28,
  migration_29,
  migration_30,
  migration_31,
  migration_32,
  migration_33,
  migration_34,
  migration_35,
  migration_36,
  migration_37,
  migration_38,
  migration_39,
  migration_40,
  migration_41,
  migration_42,
  migration_43,
  migration_44,
  migration_45,
  migration_46,
  migration_47,
  migration_48,
  migration_49,
  migration_50,
  migration_51,
  migration_52,
  migration_53,
  migration_54,
  migration_55,
  migration_56,
  migration_57,
  migration_58,
  migration_59,
  migration_60,
  migration_61,
  migration_62,
  migration_63,
  migration_64,
  migration_65,
  migration_66,
  migration_67,
  migration_68,
  migration_69,
  migration_70,
  migration_71,
  migration_72,
  migration_73,
  migration_74,
  migration_75,
  migration_76,
  migration_77,
  migration_78,
  migration_79,
  migration_80,
  migration_81,
  migration_82,
  migration_83,
  migration_84,
  migration_85,
  migration_86,
  migration_87,
  migration_88,
  migration_89,
  migration_90,
  migration_91,
  migration_92,
  migration_93,
  migration_94,
  migration_95,
  migration_96,
  migration_97,
  migration_98,
  migration_99,
  migration_100,
  migration_101,
  migration_102,
  migration_103,
  migration_104,
  migration_105,
  migration_106,
  migration_107,
  migration_108,
  migration_109,
  migration_110,
  migration_111,
  migration_112,
  migration_113,
  migration_114,
  migration_115,
  migration_116,
  migration_117,
  migration_118,
  migration_119,
  migration_120,
  migration_121,
  migration_122,
  migration_123,
  migration_124,
  migration_125,
  migration_126,
  migration_127,
  migration_128,
  migration_129,
  migration_130,
  migration_131,
  migration_132,
  migration_133,
  migration_134,
  migration_135,
  migration_136,
  migration_137,
  migration_138,
  migration_139,
  migration_140,
  migration_141,
  migration_142,
  migration_143,
  migration_144,
] satisfies DatabaseMigration.Migration[]
