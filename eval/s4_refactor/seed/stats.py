"""stats.py: a small statistics toolkit (deliberately a single flat module)."""


def mean(nums):
    return sum(nums) / len(nums)


def median(nums):
    s = sorted(nums)
    n = len(s)
    mid = n // 2
    if n % 2 == 0:
        return (s[mid - 1] + s[mid]) / 2
    return s[mid]


def stddev(nums):
    m = mean(nums)
    return (sum((x - m) ** 2 for x in nums) / len(nums)) ** 0.5


def describe(nums):
    return {
        "count": len(nums),
        "mean": mean(nums),
        "median": median(nums),
        "stddev": stddev(nums),
        "min": min(nums),
        "max": max(nums),
    }


def bucket(nums, n_buckets):
    lo, hi = min(nums), max(nums)
    if lo == hi:
        return [len(nums)] + [0] * (n_buckets - 1)
    width = (hi - lo) / n_buckets
    counts = [0] * n_buckets
    for x in nums:
        idx = min(int((x - lo) / width), n_buckets - 1)
        counts[idx] += 1
    return counts


def test():
    data = [1, 2, 3, 4, 5]
    assert mean(data) == 3
    assert median([1, 3, 5]) == 3
    assert median([1, 2, 3, 4]) == 2.5
    assert abs(stddev(data) - 2 ** 0.5) < 1e-9
    d = describe(data)
    assert d["count"] == 5 and d["min"] == 1 and d["max"] == 5
    assert sum(bucket(data, 5)) == 5
    print("All tests passed.")


if __name__ == "__main__":
    test()
