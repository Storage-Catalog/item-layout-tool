public static int lerpDiscrete(final float alpha1, final int p0, final int p1) {
    int delta = p1 - p0;
    return p0 + floor(alpha1 * (delta - 1)) + (alpha1 > 0.0F ? 1 : 0);
}

public static int getRedstoneSignalFromContainer(final @Nullable Container container) {
    if (container == null) {
        return 0;
    } else {
        float totalPercent = 0.0F;

        for (int i = 0; i < container.getContainerSize(); i++) {
            ItemStack itemStack = container.getItem(i);
            if (!itemStack.isEmpty()) {
                totalPercent += (float) itemStack.getCount() / container.getMaxStackSize(itemStack);
            }
        }

        totalPercent /= container.getContainerSize();
        return Mth.lerpDiscrete(totalPercent, 0, 15);
    }
}