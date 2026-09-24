class UserCard {
  final String id;
  final String bank;
  final String name;
  final String segment;
  final String cardProductId;
  final bool active;
  const UserCard({required this.id, required this.bank, required this.name, required this.segment, required this.cardProductId, this.active = true});
}

class RewardTier {
  final double min;
  final double? max;
  final double rate;
  const RewardTier({required this.min, this.max, required this.rate});
}

enum RewardKind { percent, fixed, tieredPercent }
enum ResetPolicy { monthly, campaign, none }
enum EnrollmentStatus { unknown, notRequired, joined, notJoined }
enum ValueSource { userConfirmed, systemEstimated, reset }

class RewardRule {
  final RewardKind kind;
  final double? rate;
  final double minSpend;
  final double? reward;
  final double? perTransactionCap;
  final List<RewardTier> tiers;
  const RewardRule({required this.kind, this.rate, this.minSpend = 0, this.reward, this.perTransactionCap, this.tiers = const []});
}

class Campaign {
  final String id;
  final String bank;
  final String title;
  final String category;
  final List<String> cardProductIds;
  final DateTime? startDate;
  final DateTime? endDate;
  final bool requiresEnrollment;
  final ResetPolicy resetPolicy;
  final double? periodCap;
  final RewardRule rewardRule;
  final bool demo;
  const Campaign({
    required this.id, required this.bank, required this.title, required this.category,
    required this.cardProductIds, this.startDate, this.endDate, this.requiresEnrollment = false,
    this.resetPolicy = ResetPolicy.campaign, this.periodCap, required this.rewardRule, this.demo = false,
  });
}

class CampaignState {
  final String campaignId;
  final String periodKey;
  final EnrollmentStatus enrollmentStatus;
  final double? remainingLimit;
  final double? usedAmount;
  final ValueSource valueSource;
  final DateTime? confirmedAt;
  final DateTime updatedAt;
  const CampaignState({
    required this.campaignId, required this.periodKey, required this.enrollmentStatus,
    this.remainingLimit, this.usedAmount, required this.valueSource, this.confirmedAt, required this.updatedAt,
  });

  CampaignState copyWith({EnrollmentStatus? enrollmentStatus, double? remainingLimit, bool setRemainingNull = false, double? usedAmount, ValueSource? valueSource, DateTime? confirmedAt, DateTime? updatedAt}) => CampaignState(
    campaignId: campaignId,
    periodKey: periodKey,
    enrollmentStatus: enrollmentStatus ?? this.enrollmentStatus,
    remainingLimit: setRemainingNull ? null : (remainingLimit ?? this.remainingLimit),
    usedAmount: usedAmount ?? this.usedAmount,
    valueSource: valueSource ?? this.valueSource,
    confirmedAt: confirmedAt ?? this.confirmedAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
}

class CampaignEvaluation {
  final Campaign campaign;
  final CampaignState state;
  final double theoreticalReward;
  final double? actualReward;
  final bool enrollmentMissing;
  final bool remainingKnown;
  const CampaignEvaluation({required this.campaign, required this.state, required this.theoreticalReward, this.actualReward, required this.enrollmentMissing, required this.remainingKnown});
}

class CardRecommendation {
  final UserCard card;
  final CampaignEvaluation? best;
  const CardRecommendation({required this.card, this.best});
}
