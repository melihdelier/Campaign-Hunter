import '../models/models.dart';

String periodKey(Campaign campaign, DateTime date) {
  if (campaign.resetPolicy == ResetPolicy.monthly) {
    return '${date.year}-${date.month.toString().padLeft(2, '0')}';
  }
  if (campaign.resetPolicy == ResetPolicy.campaign) {
    return '${campaign.id}:${campaign.startDate?.toIso8601String() ?? ''}:${campaign.endDate?.toIso8601String() ?? ''}';
  }
  return '${campaign.id}:static';
}

bool isActive(Campaign c, DateTime now) {
  if (c.startDate != null && now.isBefore(c.startDate!)) return false;
  if (c.endDate != null && now.isAfter(c.endDate!.add(const Duration(days: 1)).subtract(const Duration(milliseconds: 1)))) return false;
  return true;
}

double theoreticalReward(Campaign c, double amount) {
  final r = c.rewardRule;
  if (amount <= 0 || amount < r.minSpend) return 0;
  double value = 0;
  switch (r.kind) {
    case RewardKind.percent:
      value = amount * (r.rate ?? 0);
      break;
    case RewardKind.fixed:
      value = r.reward ?? 0;
      break;
    case RewardKind.tieredPercent:
      final matches = r.tiers.where((t) => amount >= t.min && (t.max == null || amount <= t.max!));
      if (matches.isEmpty) return 0;
      value = amount * matches.first.rate;
      break;
  }
  if (r.perTransactionCap != null && value > r.perTransactionCap!) value = r.perTransactionCap!;
  return value < 0 ? 0 : value;
}

CampaignState ensureReset(Campaign c, CampaignState? state, DateTime now) {
  final key = periodKey(c, now);
  if (state == null || state.periodKey != key) {
    return CampaignState(
      campaignId: c.id,
      periodKey: key,
      enrollmentStatus: c.requiresEnrollment ? EnrollmentStatus.unknown : EnrollmentStatus.notRequired,
      remainingLimit: c.periodCap,
      usedAmount: 0,
      valueSource: ValueSource.reset,
      confirmedAt: now,
      updatedAt: now,
    );
  }
  return state;
}

List<CardRecommendation> recommend({
  required List<UserCard> cards,
  required List<Campaign> campaigns,
  required Map<String, CampaignState> states,
  required String category,
  required double amount,
  required DateTime now,
}) {
  final result = <CardRecommendation>[];
  for (final card in cards.where((c) => c.active)) {
    final evals = <CampaignEvaluation>[];
    for (final c in campaigns) {
      if (!isActive(c, now) || c.category != category || !c.cardProductIds.contains(card.cardProductId)) continue;
      final state = ensureReset(c, states[c.id], now);
      final theoretical = theoreticalReward(c, amount);
      if (theoretical <= 0) continue;
      final missing = c.requiresEnrollment && state.enrollmentStatus != EnrollmentStatus.joined;
      final known = state.remainingLimit != null;
      final actual = missing ? 0.0 : (known ? (theoretical < state.remainingLimit! ? theoretical : state.remainingLimit!) : null);
      evals.add(CampaignEvaluation(campaign: c, state: state, theoreticalReward: theoretical, actualReward: actual, enrollmentMissing: missing, remainingKnown: known));
    }
    evals.sort((a,b) => _score(b).compareTo(_score(a)));
    result.add(CardRecommendation(card: card, best: evals.isEmpty ? null : evals.first));
  }
  result.sort((a,b) => _scoreNullable(b.best).compareTo(_scoreNullable(a.best)));
  return result;
}

double _score(CampaignEvaluation e) {
  if (e.enrollmentMissing) return 0;
  return e.actualReward ?? (e.theoreticalReward * .9);
}

double _scoreNullable(CampaignEvaluation? e) => e == null ? -1 : _score(e);
